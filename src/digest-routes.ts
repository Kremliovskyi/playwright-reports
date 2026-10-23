import { spawn } from "child_process";
import type { Express } from "express";
import { Request, Response } from "express";
import fs from "fs";
import { randomUUID } from "node:crypto";
import path from "path";
import {
  getDigests,
  getReport,
  relocateDigest,
  replaceDigests
} from "./db";
import {
  ArtifactError,
  assertOwnedPath,
  contentVersion,
  legacyDigestLocation,
  moveLegacyDigest,
  publishDigest,
  reportArtifactRoot,
  traceIdentity
} from "./report-artifacts";
import { assertReportInstance, parseDashboardReportPath } from "./report-storage";
import { activeDigests, appConfig, refreshConfigCache } from "./runtime";

const digestRecordKey = (
  digest: ReturnType<typeof getDigests>[number],
  root: string
): string => {
  if (digest.traceKey) return digest.traceKey;
  const metadata = JSON.parse(
    fs.readFileSync(
      path.join(legacyDigestLocation(root, digest), "digest.json"),
      "utf8"
    )
  );
  const identity = metadata.tracePath
    ? path.basename(metadata.tracePath).replace(/\.zip$/i, "")
    : metadata.traceSha1;
  if (!identity || typeof identity !== "string")
    throw new Error(
      "A legacy digest has no trace identity. Review it in Report Info."
    );
  return contentVersion(identity);
};

export function registerDigestRoutes(app: Express): void {

  // Find tests in a report — runs the playwright-traces-reader `find-traces` command
  app.post("/api/report-tests", (req: Request, res: Response): any => {
    refreshConfigCache();
    const { reportPath } = req.body;
    if (!reportPath)
      return res.status(400).json({ error: "reportPath is required" });

    try {
      const isArchive = reportPath.startsWith("/reports/archive/");
      const basePath = isArchive ? appConfig.archivePath : appConfig.currentPath;
      if (!basePath)
        return res.status(400).json({ error: "Base directory not configured" });

      const urlParts = reportPath.split("/");
      if (urlParts.length < 4)
        return res.status(400).json({ error: "Invalid report path format" });
      const folderName = urlParts[3];

      const reportRootPath = path.join(basePath, folderName);
      if (!fs.existsSync(reportRootPath)) {
        return res.status(404).json({ error: "Report folder not found on disk" });
      }

      const pkgMain =
        require.resolve("@andrii_kremlovskyi/playwright-traces-reader");
      const cliPath = path.join(path.dirname(pkgMain), "cli.js");

      // grep is passed as an empty string to list all tests in the report
      const child = spawn(
        process.execPath,
        [cliPath, "find-traces", reportRootPath, "", "--format", "json"],
        {
          cwd: basePath
        }
      );

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        console.error("find-traces command spawn error:", err);
        res
          .status(500)
          .json({ error: "Failed to start find-traces command: " + err.message });
      });

      child.on("close", (code) => {
        if (code !== 0) {
          console.error("find-traces command failed:", stderr || stdout);
          return res.status(500).json({
            error:
              "find-traces command failed: " +
              (stderr.trim() || `exit code ${code}`)
          });
        }
        try {
          const result = JSON.parse(stdout);
          res.json({ success: true, tests: result.traces || [] });
        } catch (e: any) {
          console.error("Failed to parse find-traces JSON:", e);
          res
            .status(500)
            .json({ error: "Invalid JSON response from find-traces command" });
        }
      });
    } catch (error: any) {
      console.error("Report tests endpoint error:", error);
      res
        .status(500)
        .json({ error: "Failed to search report tests: " + error.message });
    }
  });

  app.post(
    "/api/digest-test",
    async (req: Request, res: Response): Promise<any> => {
      refreshConfigCache();
      const config = appConfig;
      const { reportPath, tracePath, replaceDigestVersion } = req.body;
      if (typeof reportPath !== "string" || typeof tracePath !== "string")
        return res
          .status(400)
          .json({ error: "reportPath and tracePath are required" });
      let jobKey = "";
      let staging = "";
      try {
        const parsed = parseDashboardReportPath(reportPath);
        const report = parsed ? getReport(parsed.folderName) : undefined;
        if (!parsed || !report || report.reportPath !== reportPath)
          return res.status(404).json({ error: "Report not found." });
        const basePath =
          parsed.scope === "archive" ? config.archivePath : config.currentPath;
        if (!basePath || !config.currentPath)
          throw new Error("Report storage is not configured.");
        const reportRoot = path.join(basePath, report.id);
        assertOwnedPath(basePath, reportRoot);
        const traceKey = traceIdentity(reportRoot, tracePath);
        if (!fs.existsSync(tracePath))
          return res.status(404).json({ error: "Trace not found." });
        const key = `${report.uuid}:${traceKey}`;
        if (activeDigests.has(key))
          return res.status(409).json({
            code: "DIGEST_IN_PROGRESS",
            error: "This trace is already being digested."
          });
        const root = reportArtifactRoot(
          config.currentPath,
          report.uuid,
          "digests"
        );
        const records = getDigests(report.uuid);
        const previous = records.filter((digest) => {
          assertOwnedPath(
            path.join(config.currentPath, "tmp"),
            path.join(digest.runDir, digest.folder)
          );
          return digestRecordKey(digest, root) === traceKey;
        });
        const replacementVersion = contentVersion(JSON.stringify(previous));
        if (previous.length > 1 && replaceDigestVersion !== replacementVersion)
          return res.status(409).json({
            code: "DIGEST_REPLACEMENT_REQUIRED",
            error:
              "Multiple digests exist for this trace. Confirm replacing these copies with one digest.",
            version: replacementVersion,
            paths: previous.map((digest) =>
              path.join(digest.runDir, digest.folder)
            )
          });
        activeDigests.add(key);
        jobKey = key;
        fs.mkdirSync(root, { recursive: true });
        for (const digest of records) {
          if (path.resolve(digest.runDir) === path.resolve(root)) continue;
          moveLegacyDigest(root, digest, (folder) =>
            relocateDigest(digest.id, root, folder, digest.traceKey || "")
          );
          digest.runDir = root;
          digest.folder = `legacy-${digest.id}`;
        }
        staging = fs.mkdtempSync(path.join(root, ".staging-"));
        const pkgMain =
          require.resolve("@andrii_kremlovskyi/playwright-traces-reader");
        const stdout = await new Promise<string>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              path.join(path.dirname(pkgMain), "cli.js"),
              "digest",
              tracePath,
              staging,
              "--report",
              reportRoot,
              "--format",
              "json"
            ],
            { cwd: config.currentPath }
          );
          let output = "";
          let errors = "";
          child.stdout.on("data", (chunk) => {
            output += chunk.toString();
          });
          child.stderr.on("data", (chunk) => {
            errors += chunk.toString();
          });
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0
              ? resolve(output)
              : reject(
                new Error(errors.trim() || `Digest command exited with ${code}`)
              )
          );
        });
        const manifest = JSON.parse(stdout);
        assertOwnedPath(staging, manifest.runDir);
        const source = path.join(manifest.runDir, manifest.folder);
        assertOwnedPath(manifest.runDir, source);
        const metadata = JSON.parse(
          fs.readFileSync(path.join(source, "digest.json"), "utf8")
        );
        if (
          typeof metadata.tracePath !== "string" ||
          traceIdentity(reportRoot, metadata.tracePath) !== traceKey
        )
          throw new Error("Digest output does not match the requested trace.");
        if (getReport(report.id)?.uuid !== report.uuid)
          throw new Error("The report changed during digestion.");
        const canonical = path.join(root, traceKey);
        if (
          fs.existsSync(canonical) &&
          !previous.some(
            (digest) => path.join(digest.runDir, digest.folder) === canonical
          )
        )
          throw new Error(
            `Untracked digest output requires review: ${canonical}`
          );
        assertReportInstance(report, report.uuid, reportPath);
        publishDigest(root, traceKey, source, () =>
          replaceDigests(
            {
              id: previous[0]?.id || randomUUID(),
              reportId: report.uuid,
              traceKey,
              runDir: root,
              folder: traceKey,
              testTitle: manifest.testTitle || manifest.title || "",
              createdAt: new Date().toISOString()
            },
            previous.map((digest) => digest.id)
          )
        );
        for (const digest of previous) {
          const obsolete = path.join(digest.runDir, digest.folder);
          if (obsolete !== canonical)
            fs.rmSync(obsolete, { recursive: true, force: true });
        }
        const digestFolder = path
          .relative(config.currentPath, canonical)
          .split(path.sep)
          .join("/");
        return res.json({
          success: true,
          digestFolder,
          digestUrl: `/reports/current/${digestFolder}`,
          manifest: {
            ...manifest,
            outputDir: root,
            runDir: root,
            folder: traceKey
          }
        });
      } catch (error: any) {
        return res.status(error instanceof ArtifactError ? 409 : 500).json({
          code: error.code,
          error: "Failed to digest test: " + error.message
        });
      } finally {
        if (staging) {
          try {
            fs.rmSync(staging, { recursive: true, force: true });
          } catch (error) {
            console.error("Failed to clean digest staging:", error);
          }
        }
        if (jobKey) activeDigests.delete(jobKey);
      }
    }
  );
}
