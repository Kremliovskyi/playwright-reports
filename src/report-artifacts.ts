import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AnalysisRun } from "./db";

export interface ArtifactRoots {
  currentPath: string;
  archivePath: string;
  vaultPath: string;
}

export class ArtifactError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function assertOwnedPath(root: string, target: string): void {
  if (!root || !target)
    throw new ArtifactError(
      "UNSAFE_ARTIFACT_PATH",
      "Artifact storage is not configured.",
    );
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (
    !relative ||
    relative.startsWith(".." + path.sep) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new ArtifactError(
      "UNSAFE_ARTIFACT_PATH",
      `Artifact is outside its managed directory: ${target}`,
    );
  let ancestor = resolved;
  while (ancestor !== path.dirname(ancestor)) {
    try {
      if (fs.lstatSync(ancestor).isSymbolicLink())
        throw new ArtifactError(
          "UNSAFE_ARTIFACT_PATH",
          `Symbolic links cannot be removed as managed artifacts: ${ancestor}`,
        );
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    if (ancestor === base) break;
    ancestor = path.dirname(ancestor);
  }
}

export const contentVersion = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

function inspectArtifact(root: string, target: string, directory: boolean) {
  assertOwnedPath(root, target);
  try {
    const stat = fs.statSync(target);
    if (directory ? !stat.isDirectory() : !stat.isFile())
      throw new Error(`Unexpected artifact type: ${target}`);
    return {
      path: path.resolve(target),
      version: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${
        directory
          ? ["index.json", "grouped-analysis.md"]
              .map((name) => {
                const file = path.join(target, name);
                return fs.existsSync(file)
                  ? contentVersion(fs.readFileSync(file, "utf8"))
                  : "";
              })
              .join(":")
          : contentVersion(fs.readFileSync(target, "utf8"))
      }`,
    };
  } catch (error: any) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function archivedGroupedAnalysisPath(
  roots: ArtifactRoots,
  runName: string,
): string | null {
  if (!roots.archivePath) return null;
  if (!runName || path.basename(runName) !== runName)
    throw new ArtifactError("UNSAFE_ARTIFACT_PATH", "Invalid analysis name.");
  const target = path.join(roots.archivePath, "analysis", "grouped-analysis", runName + ".md");
  assertOwnedPath(roots.archivePath, target);
  return target;
}

export function analysisInventory(roots: ArtifactRoots, runs: AnalysisRun[]) {
  const issues: string[] = [];
  const entries = runs.map((run) => {
    let output: ReturnType<typeof inspectArtifact> = null;
    let grouped: ReturnType<typeof inspectArtifact> = null;
    const notes: NonNullable<ReturnType<typeof inspectArtifact>>[] = [];
    try {
      if (run.runDir)
        output = inspectArtifact(
          roots.currentPath ? path.join(roots.currentPath, "tmp") : "",
          run.runDir,
          true,
        );
      if (path.basename(run.runName) !== run.runName || !run.runName)
        throw new Error(`Invalid analysis name: ${run.runName}`);
      const noteRoots = [
        roots.vaultPath,
        roots.archivePath ? path.join(roots.archivePath, "analysis") : "",
      ].filter(Boolean);
      for (const root of new Set(noteRoots)) {
        const note = inspectArtifact(
          root,
          path.join(root, run.runName + ".md"),
          false,
        );
        if (note && !notes.some((existing) => existing.path === note.path))
          notes.push(note);
      }
      const groupedPath = archivedGroupedAnalysisPath(roots, run.runName);
      if (groupedPath)
        grouped = inspectArtifact(roots.archivePath, groupedPath, false);
    } catch (error: any) {
      issues.push(error.message);
    }
    return {
      id: run.id,
      runName: run.runName,
      createdAt: run.createdAt,
      output,
      notes,
      grouped,
    };
  });
  const outputs = new Set(
    entries.flatMap((entry) => (entry.output ? [entry.output.path] : [])),
  );
  const notes = new Set(
    entries.flatMap((entry) => entry.notes.map((note) => note.path)),
  );
  const grouped = new Set(entries.flatMap((entry) => entry.grouped ? [entry.grouped.path] : []));
  const savedAnalyses = new Set(entries
    .filter((entry) => entry.notes.length || entry.grouped)
    .map((entry) => JSON.stringify([
      ...entry.notes.map((note) => note.path),
      ...(entry.grouped ? [entry.grouped.path] : []),
    ].sort())));
  const duplicated = outputs.size > 1 || notes.size > 1 || savedAnalyses.size > 1;
  const choices = entries.map((entry) => {
    const keepPaths = [
      ...(entry.output ? [entry.output.path] : []),
      ...entry.notes.map((note) => note.path),
      ...(entry.grouped ? [entry.grouped.path] : []),
    ];
    const removePaths = [...outputs, ...notes, ...grouped].filter(
      (target) => !keepPaths.includes(target),
    );
    let blockedReason = issues.join("\n");
    if (!duplicated)
      blockedReason ||=
        "No distinct duplicate artifacts were found. Existing records require manual review.";
    if (outputs.size && !entry.output)
      blockedReason ||= "This selection would remove every output directory.";
    if (notes.size && !entry.notes.length)
      blockedReason ||=
        "This selection would remove every saved analysis file.";
    if (grouped.size && !entry.grouped && !entry.notes.length)
      blockedReason ||= "This selection would remove every saved grouped analysis.";
    if (entry.notes.length > 1)
      blockedReason ||=
        "This analysis has multiple saved notes. Review them individually before consolidation.";
    for (const removed of removePaths) {
      for (const kept of keepPaths) {
        if (
          kept.startsWith(removed + path.sep) ||
          removed.startsWith(kept + path.sep)
        )
          blockedReason ||= "Retained and duplicate artifact paths overlap.";
      }
    }
    return { runId: entry.id, keepPaths, removePaths, blockedReason };
  });
  return {
    version: contentVersion(JSON.stringify({ runs, entries, issues })),
    needsReview: runs.length > 1 || duplicated || issues.length > 0,
    duplicated,
    entries,
    choices,
    issues,
  };
}

export function removeAnalysisArtifacts(
  roots: ArtifactRoots,
  runs: AnalysisRun[],
  version: string,
  keepRunId?: string,
  otherRuns: AnalysisRun[] = [],
): string[] {
  const inventory = analysisInventory(roots, runs);
  if (inventory.version !== version)
    throw new ArtifactError(
      "ANALYSIS_CHANGED",
      "Analysis data changed. Review the current files and confirm again.",
    );
  const choice = keepRunId
    ? inventory.choices.find((entry) => entry.runId === keepRunId)
    : null;
  if (keepRunId && (!choice || choice.blockedReason))
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      choice?.blockedReason || "Select an analysis to keep.",
    );
  if (!keepRunId && inventory.needsReview)
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      "Resolve the existing analysis records before rerunning.",
    );
  const targets = choice
    ? choice.removePaths
    : inventory.entries.flatMap((entry) => [
        ...(entry.output ? [entry.output.path] : []),
        ...entry.notes.map((note) => note.path),
        ...(entry.grouped ? [entry.grouped.path] : []),
      ]);
  const others = analysisInventory(roots, otherRuns);
  const sharedPaths = otherRuns.flatMap((run) =>
    run.runDir ? [path.resolve(run.runDir)] : [],
  );
  sharedPaths.push(
    ...others.entries.flatMap((entry) => [
      ...entry.notes.map((note) => note.path),
      ...(entry.grouped ? [entry.grouped.path] : []),
    ]),
  );
  for (const target of targets) {
    if (
      sharedPaths.some(
        (other) =>
          target === other ||
          other.startsWith(target + path.sep) ||
          target.startsWith(other + path.sep),
      )
    )
      throw new ArtifactError(
        "SHARED_ARTIFACT",
        `Another analysis references this artifact: ${target}`,
      );
  }
  for (const target of targets)
    fs.rmSync(target, { recursive: true, force: true });
  return runs.filter((run) => run.id !== keepRunId).map((run) => run.id);
}

export function preserveArchiveAnalyses(
  roots: ArtifactRoots,
  runs: AnalysisRun[],
  otherRuns: AnalysisRun[],
) {
  const inventory = analysisInventory(roots, runs);
  if (inventory.issues.length)
    throw new ArtifactError("ANALYSIS_REVIEW_REQUIRED", inventory.issues.join("\n"));
  const artifacts: { source: string; destination: string; kind: "final" | "grouped" }[] = [];
  for (const [index, entry] of inventory.entries.entries()) {
    const run = runs[index];
    if (entry.notes.length > 1)
      throw new ArtifactError("ANALYSIS_REVIEW_REQUIRED", `Multiple final notes exist for ${run.runName}. Review them before archiving.`);
    if (otherRuns.some((other) =>
      other.runName === run.runName ||
      (other.runDir && run.runDir && (
        path.resolve(other.runDir) === path.resolve(run.runDir) ||
        path.resolve(other.runDir).startsWith(path.resolve(run.runDir) + path.sep) ||
        path.resolve(run.runDir).startsWith(path.resolve(other.runDir) + path.sep)
      ))
    ))
      throw new ArtifactError("SHARED_ARTIFACT", `Another report references analysis ${run.runName}.`);
    const final = entry.notes[0];
    const grouped = !final && entry.output
      ? inspectArtifact(roots.currentPath, path.join(entry.output.path, "grouped-analysis.md"), false)
      : null;
    const source = final?.path || grouped?.path || entry.grouped?.path;
    if (!source) continue;
    const destination = final
      ? path.join(roots.archivePath, "analysis", run.runName + ".md")
      : archivedGroupedAnalysisPath(roots, run.runName)!;
    assertOwnedPath(roots.archivePath, destination);
    if (path.resolve(source) !== path.resolve(destination) && fs.existsSync(destination))
      throw new ArtifactError("ARCHIVE_ARTIFACT_CONFLICT", `Archive analysis already exists: ${destination}`);
    const previous = artifacts.find((artifact) => artifact.destination === destination);
    if (previous && previous.source !== source)
      throw new ArtifactError("ARCHIVE_ARTIFACT_CONFLICT", `Multiple analyses target ${destination}`);
    if (!previous) artifacts.push({ source, destination, kind: final ? "final" : "grouped" });
  }
  const created: string[] = [];
  const rollback = () => {
    const errors: string[] = [];
    for (const target of created.splice(0).reverse()) {
      try {
        fs.unlinkSync(target);
      } catch (error) {
        errors.push(`${target}: ${String(error)}`);
      }
    }
    if (errors.length) throw new Error(`Failed to roll back preserved analysis:\n${errors.join("\n")}`);
  };
  try {
    for (const artifact of artifacts) {
      if (path.resolve(artifact.source) === path.resolve(artifact.destination)) continue;
      fs.mkdirSync(path.dirname(artifact.destination), { recursive: true });
      fs.copyFileSync(artifact.source, artifact.destination, fs.constants.COPYFILE_EXCL);
      created.push(artifact.destination);
    }
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new Error(`${String(error)}\n${String(rollbackError)}`);
    }
    throw error;
  }
  return { artifacts, rollback };
}

export function reportArtifactRoot(
  currentPath: string,
  reportUuid: string,
  kind: "analysis" | "digests",
): string {
  if (!/^[a-zA-Z0-9-]+$/.test(reportUuid))
    throw new Error("Invalid report identity.");
  const root = path.join(currentPath, "tmp", `${kind}-${reportUuid}`);
  assertOwnedPath(currentPath, root);
  return root;
}

export function traceIdentity(reportRoot: string, tracePath: string): string {
  const dataRoot = path.join(reportRoot, "data");
  assertOwnedPath(dataRoot, tracePath);
  const relative = path
    .relative(dataRoot, path.resolve(tracePath))
    .split(path.sep)
    .join("/")
    .replace(/\.zip$/i, "");
  return contentVersion(relative);
}

export function legacyDigestLocation(
  root: string,
  digest: { id: string; runDir: string; folder: string },
): string {
  const source = path.join(digest.runDir, digest.folder);
  assertOwnedPath(path.dirname(root), source);
  const destination = path.join(root, `legacy-${digest.id}`);
  assertOwnedPath(root, destination);
  if (fs.existsSync(source)) return source;
  if (fs.existsSync(destination)) return destination;
  throw new ArtifactError(
    "DIGEST_REVIEW_REQUIRED",
    `A saved digest is missing: ${source}`,
  );
}

export function moveLegacyDigest(
  root: string,
  digest: { id: string; runDir: string; folder: string },
  persist: (folder: string) => void,
): void {
  const source = legacyDigestLocation(root, digest);
  const destination = path.join(root, `legacy-${digest.id}`);
  if (source === destination) {
    persist(path.basename(destination));
    return;
  }
  if (fs.existsSync(destination))
    throw new ArtifactError(
      "DIGEST_REVIEW_REQUIRED",
      `Conflicting digest locations require review: ${source}, ${destination}`,
    );
  fs.renameSync(source, destination);
  try {
    persist(path.basename(destination));
  } catch (error) {
    fs.renameSync(destination, source);
    throw error;
  }
  try {
    fs.rmdirSync(digest.runDir);
  } catch {}
}

export function publishDigest(
  root: string,
  traceKey: string,
  source: string,
  persist: () => void,
): string {
  if (!/^[a-f0-9]{64}$/.test(traceKey))
    throw new Error("Invalid trace identity.");
  const target = path.join(root, traceKey);
  const backup = path.join(root, `.previous-${traceKey}`);
  assertOwnedPath(root, source);
  assertOwnedPath(root, target);
  assertOwnedPath(root, backup);
  if (fs.existsSync(backup)) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
    fs.renameSync(backup, target);
  }
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  let published = false;
  try {
    fs.renameSync(source, target);
    published = true;
    persist();
  } catch (error) {
    if (published) fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
  return target;
}
