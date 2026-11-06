import type { Express } from "express";
import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import {
  deleteAnalysisRun,
  deleteDigest,
  getAllReports,
  getAnalysisRuns,
  getDigests,
  getReport,
  updateAnalysisArtifacts,
} from "./db";
import { analysisInventory, analysisNoteLocations } from "./report-artifacts";
import {
  assertExclusiveAnalysis,
  preserveFinalAndDeleteOutput,
  reconcileAnalysis,
  resolveFinal,
} from "./analysis-storage";
import { isWithin, resolveReportFolder } from "./report-storage";
import {
  appConfig,
  invalidateReportSize,
  refreshConfigCache,
  reportSizeCache,
} from "./runtime";
import {
  getReportAnalysisFiles,
  resolveGroupedAnalysisFile,
  resolveVaultFile,
} from "./vault-files";

// Recursively sum the byte size of a directory tree (best-effort; unreadable entries are skipped).
// Async on purpose: a multi-GB synchronous scan blocks the event loop and stalls concurrent
// requests (e.g. /api/report-info fired alongside /api/report-size by the Info dialog).
const dirSizeBytes = async (dir: string): Promise<number> => {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await dirSizeBytes(full);
      } else if (entry.isFile()) {
        total += (await fs.promises.stat(full)).size;
      }
    } catch {
      // Skip entries that disappear or are unreadable mid-scan.
    }
  }
  return total;
};

export function registerArtifactRoutes(app: Express): void {
  // List, per report, the failure-analysis run files that exist in the vault (newest first).
  app.get("/api/analysis-runs", (req: Request, res: Response): any => {
    refreshConfigCache();
    try {
      const runs: Record<
        string,
        { runName: string; mtime: string; runDir: string }[]
      > = {};
      const issues: Record<string, string[]> = {};
      for (const report of getAllReports()) {
        const result = getReportAnalysisFiles(report.id);
        const files = result.files;
        if (files.length > 0) runs[report.id] = files;
        if (result.issues.length) issues[report.id] = result.issues;
      }
      return res.json({ runs, issues });
    } catch (error: any) {
      console.error("Analysis runs list error:", error.message);
      return res.status(500).json({ error: "Failed to list analysis runs" });
    }
  });

  // Detailed per-report info for the Info dialog: every analysis run's artifacts (size is fetched
  // separately via /api/report-size so the runs render without waiting on a recursive disk scan).
  app.get("/api/report-info", (req: Request, res: Response): any => {
    refreshConfigCache();
    const reportId =
      typeof req.query.reportId === "string" ? req.query.reportId : "";
    if (!reportId)
      return res.status(400).json({ error: "reportId is required" });

    try {
      const report = getReport(reportId);
      if (!report) return res.status(404).json({ error: "Report not found" });

      const folder = resolveReportFolder(report);
      const folderExists = !!folder && fs.existsSync(folder);

      // Archived reports never carry their ephemeral output dir along, so any leftover runDir is
      // stale (e.g. a clear that was skipped when physical removal failed). Present it as removed
      // rather than as a misleading "(missing on disk)" row.
      const isArchived = report.reportPath.startsWith("/reports/archive/");

      const resolutionErrors: string[] = [];
      const runs = getAnalysisRuns(report.uuid).map((run) => {
        const rawRunDir = run.runDir || "";
        const runDirExists = !!rawRunDir && fs.existsSync(rawRunDir);
        const runDir = isArchived && !runDirExists ? "" : rawRunDir;
        let analysisFile = run.finalAnalysisPath || "";
        let groupedAnalysisFile = run.groupedAnalysisPath || "";
        try {
          analysisFile = resolveFinal(appConfig, run) || "";
          groupedAnalysisFile =
            resolveGroupedAnalysisFile(reportId, run.runName) || "";
        } catch (error) {
          resolutionErrors.push(
            error instanceof Error ? error.message : String(error),
          );
        }
        const groupedAnalysisExists =
          !!groupedAnalysisFile && fs.existsSync(groupedAnalysisFile);
        let failuresUrl: string | null = null;
        if (
          runDirExists &&
          appConfig.currentPath &&
          isWithin(appConfig.currentPath, runDir) &&
          fs.existsSync(path.join(runDir, "index.json"))
        ) {
          const relativeRunDir = path.relative(appConfig.currentPath, runDir);
          failuresUrl = `/reports/current/${relativeRunDir.split(path.sep).join("/")}/index.json`;
        }
        return {
          runName: run.runName,
          createdAt: run.createdAt,
          runDir,
          runDirExists,
          analysisFile: analysisFile || "",
          analysisFileExists: !!analysisFile && fs.existsSync(analysisFile),
          groupedAnalysisFile: groupedAnalysisFile || "",
          groupedAnalysisExists,
          groupedAnalysisUrl: groupedAnalysisExists
            ? `/grouped-analysis?reportId=${encodeURIComponent(reportId)}&runName=${encodeURIComponent(run.runName)}`
            : null,
          failuresUrl,
          importedAt: run.importedAt,
          vaultUrl: `/final-analysis?reportId=${encodeURIComponent(reportId)}&runName=${encodeURIComponent(run.runName)}`,
        };
      });

      const digests = getDigests(report.uuid).map((digest) => {
        const digestDir = digest.runDir
          ? path.join(digest.runDir, digest.folder)
          : "";
        const digestDirExists = !!digestDir && fs.existsSync(digestDir);
        let digestUrl: string | null = null;
        if (
          digestDirExists &&
          appConfig.currentPath &&
          isWithin(appConfig.currentPath, digestDir)
        ) {
          const relativeDigestDir = path.relative(
            appConfig.currentPath,
            digestDir,
          );
          digestUrl = `/reports/current/${relativeDigestDir.split(path.sep).join("/")}/digest.json`;
        }
        return {
          id: digest.id,
          testTitle: digest.testTitle,
          createdAt: digest.createdAt,
          digestDir,
          digestDirExists,
          digestUrl,
        };
      });

      const inventory = analysisInventory(
        appConfig,
        getAnalysisRuns(report.uuid),
      );
      inventory.issues.push(...resolutionErrors);
      inventory.needsReview ||= resolutionErrors.length > 0;
      return res.json({
        reportId,
        reportUuid: report.uuid,
        folder: folder || "",
        folderExists,
        canImport: !isArchived && folderExists,
        runs,
        digests,
        analysisInventory: inventory,
      });
    } catch (error: any) {
      console.error("Report info error:", error.message);
      return res.status(500).json({ error: "Failed to load report info" });
    }
  });

  // Recursive report-folder size, cached after the first calculation. Pass ?refresh=1 to recompute.
  app.get(
    "/api/report-size",
    async (req: Request, res: Response): Promise<any> => {
      refreshConfigCache();
      const reportId =
        typeof req.query.reportId === "string" ? req.query.reportId : "";
      if (!reportId)
        return res.status(400).json({ error: "reportId is required" });

      try {
        const report = getReport(reportId);
        if (!report) return res.status(404).json({ error: "Report not found" });

        const folder = resolveReportFolder(report);
        const folderExists = !!folder && fs.existsSync(folder);
        if (!folderExists) {
          invalidateReportSize(reportId);
          return res.json({
            reportId,
            folderExists: false,
            sizeBytes: 0,
            cached: false,
          });
        }

        const refresh =
          req.query.refresh === "1" || req.query.refresh === "true";
        if (!refresh && reportSizeCache.has(reportId)) {
          return res.json({
            reportId,
            folderExists: true,
            sizeBytes: reportSizeCache.get(reportId),
            cached: true,
          });
        }

        const sizeBytes = await dirSizeBytes(folder!);
        reportSizeCache.set(reportId, sizeBytes);
        return res.json({
          reportId,
          folderExists: true,
          sizeBytes,
          cached: false,
        });
      } catch (error: any) {
        console.error("Report size error:", error.message);
        return res
          .status(500)
          .json({ error: "Failed to calculate report size" });
      }
    },
  );

  // Delete the (ephemeral) output directory of a run, detaching its DB reference while keeping the
  // report <-> analysis-file mapping intact.
  app.delete(
    "/api/analysis-run/output-dir",
    (req: Request, res: Response): any => {
      refreshConfigCache();
      const { reportId, runName } = req.body || {};
      if (!reportId || !runName)
        return res
          .status(400)
          .json({ error: "reportId and runName are required" });

      try {
        // analysis_runs rows are keyed by the report's stable uuid, not its (renameable) public id.
        const report = getReport(reportId);
        if (!report) return res.status(404).json({ error: "Report not found" });

        const run = getAnalysisRuns(report.uuid).find(
          (r) => r.runName === runName,
        );
        if (!run)
          return res.status(404).json({ error: "Analysis run not found" });

        if (!run.runDir) return res.json({ success: true });
        const migrated = reconcileAnalysis(appConfig, {
          ...run,
          groupedAnalysisPath: "",
        });
        preserveFinalAndDeleteOutput(appConfig, migrated);
        return res.json({ success: true });
      } catch (error: any) {
        console.error("Delete output dir error:", error.message);
        return res.status(500).json({
          error: "Failed to delete output directory: " + error.message,
        });
      }
    },
  );

  // Delete a run's analysis (vault) file. If the output dir reference is already gone, prune the row.
  app.delete(
    "/api/analysis-run/analysis-file",
    (req: Request, res: Response): any => {
      refreshConfigCache();
      const { reportId, runName } = req.body || {};
      if (!reportId || !runName)
        return res
          .status(400)
          .json({ error: "reportId and runName are required" });

      try {
        // analysis_runs rows are keyed by the report's stable uuid, not its (renameable) public id.
        const report = getReport(reportId);
        if (!report) return res.status(404).json({ error: "Report not found" });

        let run = getAnalysisRuns(report.uuid).find(
          (r) => r.runName === runName,
        );
        if (!run)
          return res.status(404).json({ error: "Analysis run not found" });

        if (run.storageVersion !== 1) run = reconcileAnalysis(appConfig, run);
        assertExclusiveAnalysis(appConfig, run);
        analysisNoteLocations(appConfig, run);
        const resolved =
          run.finalAnalysisPath && !fs.existsSync(run.finalAnalysisPath)
            ? null
            : resolveFinal(appConfig, run);
        if (resolved) {
          const locations = analysisNoteLocations(appConfig, run);
          if (
            !locations.some(
              (location) =>
                path.resolve(location.path) === path.resolve(resolved),
            )
          ) {
            return res.status(400).json({
              error:
                "Analysis file is outside this run's managed note locations",
            });
          }
          fs.unlinkSync(resolved);
        }
        updateAnalysisArtifacts({ ...run, finalAnalysisPath: "" });

        // Once the analysis file is gone and no output dir remains, the row has no purpose.
        if (
          (!run.runDir || !fs.existsSync(run.runDir)) &&
          !resolveGroupedAnalysisFile(reportId, runName)
        ) {
          deleteAnalysisRun(report.uuid, runName);
        }
        return res.json({ success: true });
      } catch (error: any) {
        console.error("Delete analysis file error:", error.message);
        return res
          .status(500)
          .json({ error: "Failed to delete analysis file: " + error.message });
      }
    },
  );

  // Delete a single trace digest: removes its directory from disk (guarded to currentPath) and the DB row.
  app.delete("/api/digest", (req: Request, res: Response): any => {
    refreshConfigCache();
    const { reportId, digestId } = req.body || {};
    if (!reportId || !digestId)
      return res
        .status(400)
        .json({ error: "reportId and digestId are required" });

    try {
      // digests rows are keyed by the report's stable uuid, not its (renameable) public id.
      const report = getReport(reportId);
      if (!report) return res.status(404).json({ error: "Report not found" });

      const digest = getDigests(report.uuid).find((d) => d.id === digestId);
      if (!digest) return res.status(404).json({ error: "Digest not found" });

      const digestDir = digest.runDir
        ? path.join(digest.runDir, digest.folder)
        : "";
      if (digestDir) {
        if (
          !appConfig.currentPath ||
          !isWithin(appConfig.currentPath, digestDir)
        ) {
          return res.status(400).json({
            error: "Digest directory is outside the configured current path",
          });
        }
        if (fs.existsSync(digestDir))
          fs.rmSync(digestDir, { recursive: true, force: true });
        // Remove the now-empty run-<timestamp> wrapper directory left behind.
        try {
          if (
            digest.runDir &&
            fs.existsSync(digest.runDir) &&
            fs.readdirSync(digest.runDir).length === 0
          ) {
            fs.rmdirSync(digest.runDir);
          }
        } catch {
          /* best-effort cleanup */
        }
      }
      deleteDigest(digestId);
      return res.json({ success: true });
    } catch (error: any) {
      console.error("Delete digest error:", error.message);
      return res
        .status(500)
        .json({ error: "Failed to delete digest: " + error.message });
    }
  });
}
