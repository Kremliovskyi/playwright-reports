import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Express, Request, Response } from "express";
import { getReportMetadata } from "@andrii_kremlovskyi/playwright-traces-reader";
import {
  validateManifest,
  validateAnalysisContext,
  isAnalyzableEntry,
  type FailureManifest,
} from "@andrii_kremlovskyi/playwright-failure-analyzer";
import {
  getAnalysisRuns,
  getReport,
  replaceAnalysisRun,
  type NewAnalysisRun,
  type ReportRecord,
} from "./db";
import {
  analysisInventory,
  artifactPathsOverlap,
  ArtifactError,
  assertOwnedPath,
  contentVersion,
  FINAL_ANALYSIS_FILENAME,
  managedAnalysisPaths,
  reportArtifactRoot,
  type ArtifactRoots,
} from "./report-artifacts";
import { assertExclusiveAnalysis } from "./analysis-storage";
import { assertReportInstance } from "./report-storage";
import { withReportPreparation } from "./report-preparation";
import {
  activeImports,
  appConfig,
  broadcastJson,
  refreshConfigCache,
  reportIsBusy,
} from "./runtime";

const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_BYTES = 10 * 1024 * 1024 * 1024;
type SourceFile = { relative: string; size: number; hash: string };

function bundleVersion(
  files: SourceFile[],
  directories: string[],
  finalName = FINAL_ANALYSIS_FILENAME,
) {
  return contentVersion(
    JSON.stringify({
      files: files
        .map((file) => ({
          ...file,
          relative:
            file.relative === finalName
              ? FINAL_ANALYSIS_FILENAME
              : file.relative,
        }))
        .sort((a, b) => a.relative.localeCompare(b.relative)),
      directories,
    }),
  );
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ArtifactError("INVALID_BUNDLE", `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function readJson(file: string): Record<string, unknown> {
  if (fs.statSync(file).size > MAX_METADATA_BYTES)
    throw new ArtifactError("IMPORT_LIMIT", `Metadata exceeds 16 MiB: ${file}`);
  try {
    return object(
      JSON.parse(fs.readFileSync(file, "utf8")),
      path.basename(file),
    );
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ArtifactError(
        "INVALID_BUNDLE",
        `Invalid JSON in ${path.basename(file)}: ${error.message}`,
      );
    throw error;
  }
}

function validateRelative(root: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.split(/[\\/]/).includes("..")
  )
    throw new ArtifactError(
      "INVALID_BUNDLE",
      "Artifact references must stay inside the bundle.",
    );
  const file = path.resolve(root, value);
  assertOwnedPath(root, file);
  if (!fs.existsSync(file))
    throw new ArtifactError(
      "INVALID_BUNDLE",
      `Referenced artifact is missing: ${value}`,
    );
  return file;
}

async function fingerprint(root: string, signal?: AbortSignal) {
  const files: SourceFile[] = [];
  const directories: string[] = [];
  let bytes = 0;
  async function visit(directory: string, depth = 0): Promise<void> {
    signal?.throwIfAborted();
    if (depth > 128)
      throw new ArtifactError(
        "IMPORT_LIMIT",
        "Import directory depth exceeds 128.",
      );
    for (const entry of await fs.promises.readdir(directory, {
      withFileTypes: true,
    })) {
      const file = path.join(directory, entry.name);
      assertOwnedPath(root, file);
      const stat = await fs.promises.lstat(file);
      if (
        stat.isSymbolicLink() ||
        (!stat.isFile() && !stat.isDirectory()) ||
        (stat.isFile() && stat.nlink > 1)
      )
        throw new ArtifactError(
          "INVALID_BUNDLE",
          "Links and special files cannot be imported.",
        );
      if (files.length + directories.length >= MAX_FILES)
        throw new ArtifactError(
          "IMPORT_LIMIT",
          "Import exceeds 100,000 filesystem entries.",
        );
      if (stat.isDirectory()) {
        directories.push(path.relative(root, file));
        await visit(file, depth + 1);
        continue;
      }
      bytes += stat.size;
      if (files.length >= MAX_FILES || bytes > MAX_BYTES)
        throw new ArtifactError(
          "IMPORT_LIMIT",
          "Import exceeds 100,000 files or 10 GiB.",
        );
      const hash = createHash("sha256");
      const stream = fs.createReadStream(file, { signal });
      await Promise.all([
        finished(stream, { cleanup: true }),
        (async () => {
          for await (const chunk of stream) hash.update(chunk);
        })(),
      ]);
      files.push({
        relative: path.relative(root, file),
        size: stat.size,
        hash: hash.digest("hex"),
      });
    }
  }
  await visit(root);
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  directories.sort();
  return {
    files,
    directories,
    bytes,
    version: bundleVersion(files, directories),
  };
}

async function selectRoot(input: unknown): Promise<string> {
  if (typeof input !== "string" || !path.isAbsolute(input.trim()))
    throw new ArtifactError(
      "INVALID_BUNDLE",
      "Enter an absolute directory path on the dashboard machine.",
    );
  const root = path.resolve(input.trim());
  assertOwnedPath(path.parse(root).root, root);
  if (!fs.statSync(root).isDirectory())
    throw new ArtifactError("INVALID_BUNDLE", "Source must be a directory.");
  const isBundle = (candidate: string) =>
    fs.existsSync(path.join(candidate, "index.json")) ||
    fs.existsSync(path.join(candidate, "analysis-result.json"));
  if (isBundle(root)) return root;
  const candidates = (await fs.promises.readdir(root, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && isBundle(path.join(root, entry.name)),
    )
    .map((entry) => path.join(root, entry.name));
  if (candidates.length !== 1)
    throw new ArtifactError(
      "SELECT_BUNDLE",
      candidates.length
        ? `Select one exact run directory:\n${candidates.join("\n")}`
        : "No analysis bundle was found in this directory.",
    );
  assertOwnedPath(root, candidates[0]);
  return candidates[0];
}

export async function inspectImport(
  sourcePath: unknown,
  report: ReportRecord,
  signal?: AbortSignal,
) {
  const source = await selectRoot(sourcePath);
  const runName = path.basename(source);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runName))
    throw new ArtifactError(
      "INVALID_BUNDLE",
      "The run directory name is not portable.",
    );
  const snapshot = await fingerprint(source, signal);
  const manifestPath = path.join(source, "index.json");
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile())
    throw new ArtifactError(
      "INVALID_BUNDLE",
      "An analysis bundle requires an index.json file.",
    );
  const resultFile = path.join(source, "analysis-result.json");
  const result = fs.existsSync(resultFile) ? readJson(resultFile) : undefined;
  let createdAt = "";
  const warnings: string[] = [];
  if (result) {
    if (result.schemaVersion !== 1 && result.schemaVersion !== 2)
      throw new ArtifactError(
        "INVALID_BUNDLE",
        "Unsupported analysis-result schema.",
      );
    if (
      !["complete", "partial", "failed", "cancelled", "no-failures"].includes(
        String(result.status),
      )
    )
      throw new ArtifactError("INVALID_BUNDLE", "Unknown analysis status.");
    if (result.schemaVersion === 2) {
      if (
        result.runId !== runName ||
        typeof result.createdAt !== "string" ||
        !Number.isFinite(Date.parse(result.createdAt)) ||
        new Date(result.createdAt).toISOString() !== result.createdAt ||
        !runName.startsWith(`run-${result.createdAt.replace(/[:.]/g, "-")}-`) ||
        !/^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[A-Za-z0-9]{6}$/.test(
          runName,
        )
      )
        throw new ArtifactError(
          "INVALID_BUNDLE",
          "Run identity or UTC creation time does not match the directory name.",
        );
      if (!result.source)
        throw new ArtifactError(
          "INVALID_BUNDLE",
          "Source provenance is missing.",
        );
      try {
        validateAnalysisContext({
          source: result.source,
          environment: result.environment,
          region: result.region,
        });
      } catch (error) {
        throw new ArtifactError(
          "INVALID_BUNDLE",
          `Invalid provenance: ${String(error)}`,
        );
      }
      createdAt = result.createdAt;
    }
    const artifacts = object(result.artifacts, "artifacts");
    for (const [key, filename] of Object.entries({
      manifest: "index.json",
      result: "analysis-result.json",
      summary: "summary.md",
      groupedAnalysis: "grouped-analysis.md",
    })) {
      if (artifacts[key] === undefined && key !== "result" && key !== "summary")
        continue;
      if (
        key === "groupedAnalysis" &&
        artifacts[key] === filename &&
        !fs.existsSync(path.join(source, filename))
      )
        continue;
      if (
        artifacts[key] !== filename ||
        !fs.statSync(validateRelative(source, artifacts[key])).isFile()
      )
        throw new ArtifactError(
          "INVALID_BUNDLE",
          `Invalid ${key} artifact reference.`,
        );
    }
    if (!Array.isArray(artifacts.attempts))
      throw new ArtifactError(
        "INVALID_BUNDLE",
        "Artifact attempts must be an array.",
      );
    for (const reference of artifacts.attempts)
      if (!fs.statSync(validateRelative(source, reference)).isDirectory())
        throw new ArtifactError(
          "INVALID_BUNDLE",
          "Attempt references must identify directories.",
        );
    if (Array.isArray(result.warnings))
      warnings.push(...result.warnings.map(String));
    if (Array.isArray(result.errors))
      warnings.push(
        ...result.errors.map((error) => String(object(error, "error").message)),
      );
    if (result.status !== "complete" && result.status !== "no-failures")
      warnings.push(`Source analysis status: ${result.status}`);
  } else warnings.push("Legacy bundle: completion metadata is unknown.");
  if (!createdAt) {
    const match =
      /^run-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(
        runName,
      );
    if (match) {
      const candidate = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
      if (
        Number.isFinite(Date.parse(candidate)) &&
        new Date(candidate).toISOString() === candidate
      )
        createdAt = candidate;
    }
    if (!createdAt)
      warnings.push(
        "Analysis creation date is unknown; import time is recorded separately.",
      );
  }
  const data = readJson(manifestPath);
  if (data.schemaVersion !== 2)
    throw new ArtifactError("INVALID_BUNDLE", "Unsupported manifest schema.");
  let manifest: FailureManifest;
  try {
    manifest = validateManifest(data, source);
  } catch (error) {
    throw new ArtifactError(
      "INVALID_BUNDLE",
      `Invalid manifest: ${String(error)}`,
    );
  }
  for (const entry of manifest.failures.filter(isAnalyzableEntry)) {
    const evidenceFile = path.join(source, entry.folder, "evidence.json");
    if (!fs.existsSync(evidenceFile)) {
      warnings.push(`Evidence unavailable: ${entry.folder}`);
      continue;
    }
    if (readJson(evidenceFile).schemaVersion !== 4)
      throw new ArtifactError(
        "INVALID_BUNDLE",
        `Unsupported evidence schema: ${entry.folder}`,
      );
  }
  const grouped = fs.existsSync(path.join(source, "grouped-analysis.md"));
  const canonical = fs.existsSync(path.join(source, FINAL_ANALYSIS_FILENAME));
  const legacy = fs.existsSync(path.join(source, runName + ".md"));
  if (canonical && legacy)
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      "Both canonical and legacy final files exist. Resolve the conflict before import.",
    );
  const finalName = canonical
    ? FINAL_ANALYSIS_FILENAME
    : legacy
      ? runName + ".md"
      : "";
  for (const name of [
    finalName,
    grouped ? "grouped-analysis.md" : "",
    fs.existsSync(path.join(source, "summary.md")) ? "summary.md" : "",
  ].filter(Boolean))
    if (!fs.statSync(path.join(source, name)).isFile())
      throw new ArtifactError(
        "INVALID_BUNDLE",
        `${name} must be a regular file.`,
      );
    else if (fs.statSync(path.join(source, name)).size > MAX_METADATA_BYTES)
      throw new ArtifactError(
        "IMPORT_LIMIT",
        `Analysis Markdown exceeds 16 MiB: ${name}`,
      );
  const metadata = await getReportMetadata(
    assertReportInstance(report, report.uuid, report.reportPath),
  );
  const traces = new Map<string, Set<number>>();
  for (const file of metadata?.files || [])
    for (const test of file.tests)
      for (const [index, attempt] of test.results.entries())
        for (const attachment of attempt.attachments || [])
          if (attachment.name === "trace" && attachment.path) {
            const name = path.basename(
              attachment.path.replace(/\\/g, "/"),
              ".zip",
            );
            if (!traces.has(name)) traces.set(name, new Set());
            traces.get(name)!.add(index);
          }
  const attempts = manifest.failures.filter(isAnalyzableEntry);
  if (
    traces.size &&
    attempts.some(
      (entry) =>
        entry.traceSha1 && !traces.get(entry.traceSha1)?.has(entry.retryIndex),
    )
  )
    throw new ArtifactError(
      "REPORT_MISMATCH",
      "The bundle's trace/retry identities do not belong to this HTML report.",
    );
  const verified =
    !!attempts.length &&
    attempts.every(
      (entry) =>
        entry.traceSha1 && traces.get(entry.traceSha1)?.has(entry.retryIndex),
    );
  if (!verified)
    warnings.push(
      "Association unverified: the HTML report has insufficient matching trace metadata.",
    );
  return {
    source,
    runName,
    createdAt,
    grouped,
    finalName,
    verified,
    warnings,
    sourceMetadata: result
      ? {
          source: result.source,
          environment: result.environment,
          region: result.region,
          status: result.status,
        }
      : null,
    ...snapshot,
  };
}

export function pendingImports(roots: ArtifactRoots, reportUuid: string) {
  if (!roots.currentPath) return [];
  const root = path.join(roots.currentPath, "tmp", "analysis-imports");
  assertOwnedPath(roots.currentPath, root);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => /^import-[a-zA-Z0-9]{6}$/.test(name))
    .flatMap((name) => {
      const file = path.join(root, name, "import.json");
      assertOwnedPath(root, file);
      if (!fs.existsSync(file)) return [];
      const journal = readJson(file);
      if (journal.reportUuid !== reportUuid) return [];
      return [
        {
          transaction: name,
          directory: path.dirname(file),
          journal,
          committed: getAnalysisRuns(reportUuid).some(
            (run) => run.id === journal.newId,
          ),
        },
      ];
    });
}

async function cleanupTransaction(directory: string) {
  for (const name of await fs.promises.readdir(directory)) {
    if (name !== "import.json")
      await fs.promises.rm(path.join(directory, name), { recursive: true });
  }
  await fs.promises.rm(path.join(directory, "import.json"), { force: true });
  await fs.promises.rmdir(directory);
}

async function renameImportedArtifact(
  source: string,
  destination: string,
  signal?: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 5 ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EPERM", "EACCES", "EBUSY"].includes(String(error.code))
      )
        throw error;
      console.warn(
        "Retrying analysis import rename after a temporary Windows file lock:",
        String(error),
      );
      await delay(50 * 2 ** attempt, undefined, { signal });
    }
  }
}

async function writeJournal(directory: string, journal: object) {
  const temporary = path.join(directory, "import.next");
  const fd = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(fd, JSON.stringify(journal));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  await renameImportedArtifact(temporary, path.join(directory, "import.json"));
}

export function registerImportRoutes(app: Express): void {
  app.get("/api/analysis/import/recovery", (req, res) => {
    refreshConfigCache();
    const report =
      typeof req.query.reportId === "string"
        ? getReport(req.query.reportId)
        : undefined;
    if (!report) return res.status(404).json({ error: "Report not found" });
    res.json({
      transactions: pendingImports(appConfig, report.uuid).map(
        ({ transaction, committed }) => ({ transaction, committed }),
      ),
    });
  });
  app.post("/api/analysis/import/recover", async (req, res) => {
    refreshConfigCache();
    const report =
      typeof req.body?.reportId === "string"
        ? getReport(req.body.reportId)
        : undefined;
    if (!report || req.body.reportUuid !== report.uuid)
      throw new ArtifactError("REPORT_CHANGED", "Report identity changed.");
    if (reportIsBusy(report.uuid))
      throw new ArtifactError("REPORT_ARTIFACTS_BUSY", "Report is busy.");
    const pending = pendingImports(appConfig, report.uuid).find(
      (item) => item.transaction === req.body.transaction,
    );
    if (!pending)
      return res.status(404).json({ error: "Recovery transaction not found" });
    const { journal, directory } = pending;
    if (
      typeof journal.runName !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(journal.runName)
    )
      throw new ArtifactError(
        "IMPORT_RECOVERY_REQUIRED",
        "Invalid recovery identity.",
      );
    const destination = path.join(
      reportArtifactRoot(appConfig.currentPath, report.uuid, "analysis"),
      journal.runName,
    );
    if (
      journal.destination !== destination ||
      !Array.isArray(journal.backups) ||
      !Array.isArray(journal.expectedIds)
    )
      throw new ArtifactError(
        "IMPORT_RECOVERY_REQUIRED",
        "Invalid recovery manifest.",
      );
    activeImports.add(report.uuid);
    try {
      if (!pending.committed) {
        const current = getAnalysisRuns(report.uuid);
        if (
          JSON.stringify(current.map((run) => run.id).sort()) !==
          JSON.stringify([...journal.expectedIds].sort())
        )
          throw new ArtifactError(
            "IMPORT_RECOVERY_REQUIRED",
            "Records changed since interruption; manual review is required.",
          );
        const registered = current
          .flatMap((run) => [
            run.runDir,
            run.finalAnalysisPath,
            run.groupedAnalysisPath,
          ])
          .filter(Boolean);
        const backups = journal.backups.map((item, index) => {
          const entry = object(item, "backup");
          if (
            typeof entry.source !== "string" ||
            !registered.includes(entry.source) ||
            entry.backup !== path.join(directory, `previous-${index}`)
          )
            throw new ArtifactError(
              "IMPORT_RECOVERY_REQUIRED",
              "Recovery points outside registered storage.",
            );
          const backup = String(entry.backup);
          assertOwnedPath(directory, backup);
          return { source: entry.source, backup };
        });
        const originalStillPresent = backups.some(
          (item) => item.source === destination && !fs.existsSync(item.backup),
        );
        if (fs.existsSync(destination) && !originalStillPresent) {
          if ((await fingerprint(destination)).version !== journal.version)
            throw new ArtifactError(
              "IMPORT_RECOVERY_REQUIRED",
              "Published files changed after interruption; review them before recovery.",
            );
          fs.rmSync(destination, { recursive: true });
        }
        for (const item of backups) {
          if (!fs.existsSync(item.backup)) continue;
          if (fs.existsSync(item.source))
            throw new ArtifactError(
              "IMPORT_RECOVERY_REQUIRED",
              `Recovery destination already exists: ${item.source}`,
            );
          fs.mkdirSync(path.dirname(item.source), { recursive: true });
          await renameImportedArtifact(item.backup, item.source);
        }
      }
      await cleanupTransaction(directory);
      return res.json({ success: true, committed: pending.committed });
    } finally {
      activeImports.delete(report.uuid);
    }
  });
  app.post("/api/analysis/import/preview", async (req, res) => {
    refreshConfigCache();
    const report =
      typeof req.body?.reportId === "string"
        ? getReport(req.body.reportId)
        : undefined;
    if (!report || !report.reportPath.startsWith("/reports/current/"))
      return res.status(400).json({ error: "Select a current report." });
    const bundle = await inspectImport(req.body.sourcePath, report);
    const runs = getAnalysisRuns(report.uuid);
    const inventory = analysisInventory(appConfig, runs);
    return res.json({
      ...bundle,
      files: undefined,
      directories: undefined,
      fileCount: bundle.files.length,
      reportUuid: report.uuid,
      inventory,
      destination: path.join(
        reportArtifactRoot(appConfig.currentPath, report.uuid, "analysis"),
        bundle.runName,
      ),
    });
  });
  app.post("/api/analysis/import", async (req: Request, res: Response) => {
    refreshConfigCache();
    const report =
      typeof req.body?.reportId === "string"
        ? getReport(req.body.reportId)
        : undefined;
    if (!report || !report.reportPath.startsWith("/reports/current/"))
      return res.status(400).json({ error: "Select a current report." });
    if (req.body.reportUuid !== report.uuid)
      throw new ArtifactError(
        "REPORT_CHANGED",
        "Confirm the report's current UUID by inspecting again.",
      );
    if (reportIsBusy(report.uuid))
      return res.status(409).json({ error: "Report is busy." });
    activeImports.add(report.uuid);
    const config = appConfig;
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded)
        controller.abort(new Error("Import connection closed."));
    });
    let staging = "";
    let published = "";
    let committed = false;
    let recoveryRequired = false;
    const backups: { source: string; backup: string }[] = [];
    try {
      await withReportPreparation(async () => {
        const bundle = await inspectImport(
          req.body.sourcePath,
          report,
          controller.signal,
        );
        if (req.body.sourceVersion !== bundle.version)
          throw new ArtifactError(
            "ANALYSIS_CHANGED",
            "Source changed. Inspect again.",
          );
        if (!bundle.verified && req.body.confirmUnverified !== true)
          throw new ArtifactError(
            "ASSOCIATION_UNVERIFIED",
            "Explicitly confirm the unverified report association.",
          );
        const runs = getAnalysisRuns(report.uuid);
        const inventory = analysisInventory(config, runs);
        if (
          inventory.needsReview ||
          req.body.analysisVersion !== inventory.version
        )
          throw new ArtifactError(
            "ANALYSIS_CHANGED",
            "Current analysis changed or needs review. Inspect again.",
          );
        for (const run of runs) assertExclusiveAnalysis(config, run);
        const destination = path.join(
          reportArtifactRoot(config.currentPath, report.uuid, "analysis"),
          bundle.runName,
        );
        assertOwnedPath(config.currentPath, destination);
        if (path.relative(bundle.source, destination) === "")
          throw new ArtifactError(
            "INVALID_BUNDLE",
            "Select an external source, not the managed output directory.",
          );
        if (
          runs.length === 1 &&
          runs[0].runDir === destination &&
          fs.existsSync(destination) &&
          (await fingerprint(destination, controller.signal)).version ===
            bundleVersion(bundle.files, bundle.directories, bundle.finalName)
        ) {
          committed = true;
          res.json({ success: true, unchanged: true });
          return;
        }
        if (runs.length && req.body.replaceRunId !== runs[0].id)
          throw new ArtifactError(
            "ANALYSIS_REPLACEMENT_REQUIRED",
            "Confirm replacement of the current analysis, including its final.",
          );
        const oldPaths = managedAnalysisPaths(config, runs);
        if (fs.existsSync(destination) && !oldPaths.includes(destination))
          throw new ArtifactError(
            "ANALYSIS_REVIEW_REQUIRED",
            "The destination contains unregistered files.",
          );
        if (
          artifactPathsOverlap(bundle.source, destination) ||
          oldPaths.some((file) => artifactPathsOverlap(bundle.source, file))
        )
          throw new ArtifactError(
            "INVALID_BUNDLE",
            "Import source overlaps existing managed artifacts.",
          );
        const temporaryRoot = path.join(
          config.currentPath,
          "tmp",
          "analysis-imports",
        );
        assertOwnedPath(config.currentPath, temporaryRoot);
        await fs.promises.mkdir(temporaryRoot, { recursive: true });
        const space = await fs.promises.statfs(temporaryRoot);
        if (space.bavail * space.bsize < bundle.bytes + MAX_METADATA_BYTES)
          throw new ArtifactError(
            "IMPORT_SPACE",
            "Insufficient free space for the staged import.",
          );
        staging = await fs.promises.mkdtemp(
          path.join(temporaryRoot, "import-"),
        );
        const newId = randomUUID();
        const journal = {
          reportUuid: report.uuid,
          runName: bundle.runName,
          newId,
          expectedIds: runs.map((item) => item.id),
          destination,
          version: "",
          backups: oldPaths.map((source, index) => ({
            source,
            backup: path.join(staging, `previous-${index}`),
          })),
        };
        await writeJournal(staging, journal);
        const copied = path.join(staging, bundle.runName);
        await fs.promises.mkdir(copied);
        for (const directory of bundle.directories)
          await fs.promises.mkdir(path.join(copied, directory), {
            recursive: true,
          });
        for (const [index, file] of bundle.files.entries()) {
          controller.signal.throwIfAborted();
          const original = validateRelative(bundle.source, file.relative);
          const target = path.join(copied, file.relative);
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await fs.promises.copyFile(
            original,
            target,
            fs.constants.COPYFILE_EXCL,
          );
          broadcastJson("analysis-import", {
            reportUuid: report.uuid,
            completed: index + 1,
            total: bundle.files.length,
          });
        }
        if (
          (await fingerprint(copied, controller.signal)).version !==
            bundle.version ||
          (await fingerprint(bundle.source, controller.signal)).version !==
            bundle.version
        )
          throw new ArtifactError(
            "ANALYSIS_CHANGED",
            "Source changed during copying. No import was committed.",
          );
        if (bundle.finalName && bundle.finalName !== FINAL_ANALYSIS_FILENAME)
          await renameImportedArtifact(
            path.join(copied, bundle.finalName),
            path.join(copied, FINAL_ANALYSIS_FILENAME),
            controller.signal,
          );
        journal.version = (
          await fingerprint(copied, controller.signal)
        ).version;
        await writeJournal(staging, journal);
        assertReportInstance(report, report.uuid, report.reportPath);
        if (
          analysisInventory(config, getAnalysisRuns(report.uuid)).version !==
          inventory.version
        )
          throw new ArtifactError(
            "ANALYSIS_CHANGED",
            "Analysis changed during copying.",
          );
        controller.signal.throwIfAborted();
        for (const [index, file] of oldPaths.entries()) {
          const backup = path.join(staging, `previous-${index}`);
          await renameImportedArtifact(file, backup, controller.signal);
          backups.push({ source: file, backup });
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        await renameImportedArtifact(copied, destination, controller.signal);
        published = destination;
        const run: NewAnalysisRun = {
          id: newId,
          reportId: report.uuid,
          runName: bundle.runName,
          runDir: destination,
          createdAt: bundle.createdAt,
          importedAt: new Date().toISOString(),
          finalAnalysisPath: bundle.finalName
            ? path.join(destination, FINAL_ANALYSIS_FILENAME)
            : "",
          groupedAnalysisPath: bundle.grouped
            ? path.join(destination, "grouped-analysis.md")
            : "",
        };
        replaceAnalysisRun(
          run,
          runs.map((item) => item.id),
        );
        committed = true;
        await cleanupTransaction(staging);
        staging = "";
        res.json({ success: true, warnings: bundle.warnings, run });
      });
    } catch (error) {
      if (committed) {
        recoveryRequired = true;
        throw new ArtifactError(
          "IMPORT_RECOVERY_REQUIRED",
          `Import committed, but cleanup failed. Review retained transaction files at ${staging}: ${String(error)}`,
        );
      }
      if (!committed) {
        try {
          if (published) fs.rmSync(published, { recursive: true, force: true });
          for (const item of backups.reverse())
            await renameImportedArtifact(item.backup, item.source);
        } catch (rollbackError) {
          recoveryRequired = true;
          throw new ArtifactError(
            "IMPORT_RECOVERY_REQUIRED",
            `Import failed: ${String(error)}. Recovery files remain at ${staging}: ${String(rollbackError)}`,
          );
        }
      }
      throw error;
    } finally {
      try {
        if (
          staging &&
          !recoveryRequired &&
          !backups.some((item) => fs.existsSync(item.backup))
        )
          await cleanupTransaction(staging);
      } finally {
        activeImports.delete(report.uuid);
      }
    }
  });
}
