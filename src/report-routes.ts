import type { Express } from "express";
import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import {
  clearAnalysisRunDir,
  deleteAnalysisRunsByReport,
  deleteReportRecord,
  getAllAnalysisRuns,
  getAnalysisRuns,
  getReport,
  updateReportMetadata
} from "./db";
import {
  archivedGroupedAnalysisPath,
  ArtifactError,
  preserveArchiveAnalyses
} from "./report-artifacts";
import { assertCurrentReportSource, isWithin, moveReportFolder, purgeReportDigests } from "./report-storage";
import { appConfig, invalidateReportSize, refreshConfigCache } from "./runtime";
import { resolveVaultFile } from "./vault-files";

export function registerReportRoutes(app: Express): void {

  // Auto-extract traces endpoint
  app.post("/api/extract", (req: Request, res: Response): any => {
    const { reportPath } = req.body;
    if (!reportPath)
      return res.status(400).json({ error: "reportPath is required" });

    try {
      // 1. Determine which base directory this is from (current vs archive)
      const isArchive = reportPath.startsWith("/reports/archive/");
      const basePath = isArchive ? appConfig.archivePath : appConfig.currentPath;

      if (!basePath) {
        return res.status(400).json({ error: "Base directory not configured" });
      }

      // 2. Extract the actual report folder name from the URL path
      // e.g., /reports/current/my-test-run/index.html -> my-test-run
      const urlParts = reportPath.split("/");
      if (urlParts.length < 4)
        return res.status(400).json({ error: "Invalid report path format" });

      const folderName = urlParts[3];

      // 3. Construct the absolute physical path to the report's data folder
      const physicalDataFolder = path.join(basePath, folderName, "data");

      if (!fs.existsSync(physicalDataFolder)) {
        return res.json({
          success: true,
          extractedCount: 0,
          message: "No data folder found, nothing to extract."
        });
      }

      // 4. Scan the data folder for .zip files
      let extractedCount = 0;
      const entries = fs.readdirSync(physicalDataFolder, { withFileTypes: true });

      for (const dirent of entries) {
        if (dirent.isFile() && dirent.name.endsWith(".zip")) {
          const zipFile = path.join(physicalDataFolder, dirent.name);

          // Target extraction folder: drop the '.zip' extension
          const targetFolderName = dirent.name.replace(".zip", "");
          const targetExtractionPath = path.join(
            physicalDataFolder,
            targetFolderName
          );

          // Idempotency check: Skip if the unzipped folder already exists!
          if (fs.existsSync(targetExtractionPath)) {
            continue;
          }

          // Lazy load AdmZip only when actually extracting to save memory globally
          const AdmZip = require("adm-zip");
          const zip = new AdmZip(zipFile);

          // Extract everything into the newly named folder
          zip.extractAllTo(targetExtractionPath, true); // true = overwrite
          extractedCount++;
        }
      }

      if (extractedCount > 0) invalidateReportSize(folderName);
      res.json({ success: true, extractedCount });
    } catch (error: any) {
      console.error("Extraction error:", error);
      res
        .status(500)
        .json({ error: "Failed to extract trace files: " + error.message });
    }
  });

  app.post("/api/archive", (req: Request, res: Response): any => {
    refreshConfigCache();
    const { reportPath } = req.body;

    if (typeof reportPath !== "string" || !reportPath)
      return res.status(400).json({ error: "reportPath is required" });
    if (!appConfig.archivePath)
      return res.status(400).json({
        error:
          "Archive directory is not configured! Please open Preferences and set an archive path first."
      });

    try {
      // Determine source directory
      const isArchive = reportPath.startsWith("/reports/archive/");
      if (isArchive)
        return res
          .status(400)
          .json({ error: "Report is already in the archive" });

      if (!appConfig.currentPath)
        return res
          .status(400)
          .json({ error: "Current directory not configured" });

      // Extract the actual report folder name from the URL path
      const urlParts = reportPath.split("/");
      if (urlParts.length < 4)
        return res.status(400).json({ error: "Invalid report path format" });

      const folderName = urlParts[3];

      // Construct the absolute physical source path
      const sourcePhysicalFolder = path.join(appConfig.currentPath, folderName);

      if (!fs.existsSync(sourcePhysicalFolder)) {
        return res.status(404).json({ error: "Report folder not found on disk" });
      }

      const report = getReport(folderName);
      if (!report || report.reportPath !== reportPath)
        return res.status(404).json({ error: "Report not found in the report index." });
      assertCurrentReportSource(report);
      let timestamp = Date.now();
      let uniqueArchivedName: string;
      do {
        uniqueArchivedName = `playwright-report-${timestamp++}`;
      } while (getReport(uniqueArchivedName) || fs.existsSync(path.join(appConfig.archivePath, uniqueArchivedName)));
      const reportUuid = report.uuid;
      const archivedRuns = getAnalysisRuns(reportUuid);
      const preserved = preserveArchiveAnalyses(
        appConfig,
        archivedRuns,
        getAllAnalysisRuns().filter((run) => run.reportId !== reportUuid)
      );
      try {
        moveReportFolder(report, uniqueArchivedName, appConfig.archivePath, "archive");
      } catch (error) {
        try {
          preserved.rollback();
        } catch (rollbackError) {
          throw new Error(`${String(error)}\n${String(rollbackError)}`);
        }
        throw error;
      }

      // Preservation is complete. Cleanup cannot undo the archived report.
      for (const artifact of preserved.artifacts) {
        if (artifact.kind === "final" && path.resolve(artifact.source) !== path.resolve(artifact.destination)) {
          try {
            fs.unlinkSync(artifact.source);
          } catch (error) {
            console.warn("Failed to remove the archived note's source copy:", error);
          }
        }
      }
      try {
        for (const run of archivedRuns) {
          // Remove the ephemeral output directory and detach its reference (keep the analysis mapping).
          // Detach the DB reference unconditionally: even if the physical removal fails (e.g. a locked
          // file on Windows), the output dir does not follow the report into the archive, so leaving a
          // stale runDir would surface a misleading "(missing on disk)" row in Report Info.
          try {
            if (run.runDir && fs.existsSync(run.runDir)) {
              fs.rmSync(run.runDir, { recursive: true, force: true });
            }
          } catch (rmErr) {
            console.warn(
              "Failed to remove output directory during archive:",
              rmErr
            );
          }
          clearAnalysisRunDir(reportUuid, run.runName);
        }

        purgeReportDigests(reportUuid);
      } catch (error) {
        console.warn("Post-archive cleanup failed:", error);
      }

      res.json({ success: true, newName: uniqueArchivedName });
    } catch (error: any) {
      console.error("Archive error:", error);
      res
        .status(error instanceof ArtifactError ? 409 : 500)
        .json({ error: "Failed to archive report: " + error.message });
    }
  });

  // Auto-delete report endpoint
  app.post("/api/delete", (req: Request, res: Response): any => {
    const { reportPath } = req.body;
    if (!reportPath)
      return res.status(400).json({ error: "reportPath is required" });

    try {
      // Determine which base directory this is from (current vs archive)
      const isArchive = reportPath.startsWith("/reports/archive/");
      const basePath = isArchive ? appConfig.archivePath : appConfig.currentPath;

      if (!basePath) {
        return res.status(400).json({ error: "Base directory not configured" });
      }

      // Extract the actual report folder name from the URL path
      const urlParts = reportPath.split("/");
      if (urlParts.length < 4)
        return res.status(400).json({ error: "Invalid report path format" });

      const folderName = urlParts[3];

      // Construct the absolute physical path to the report folder
      const targetPhysicalFolder = path.join(basePath, folderName);

      if (!fs.existsSync(targetPhysicalFolder)) {
        return res.status(404).json({ error: "Report folder not found on disk" });
      }

      const reportUuid = getReport(folderName)?.uuid || "";
      const runs = getAnalysisRuns(reportUuid);
      const otherRuns = getAllAnalysisRuns().filter((run) => run.reportId !== reportUuid);
      const groupedFiles = runs.flatMap((run) => {
        const grouped = archivedGroupedAnalysisPath(appConfig, run.runName);
        if (!grouped || !fs.existsSync(grouped)) return [];
        if (otherRuns.some((other) => other.runName === run.runName))
          throw new ArtifactError("SHARED_ARTIFACT", `Another report references grouped analysis ${run.runName}.`);
        return [grouped];
      });
      for (const grouped of new Set(groupedFiles)) fs.unlinkSync(grouped);

      // Delete the directory and its contents
      fs.rmSync(targetPhysicalFolder, { recursive: true, force: true });

      // Delete associated analysis (vault) files and ephemeral output directories for every
      // persisted run of this report.
      for (const run of runs) {
        const runFile = resolveVaultFile(run.runName);
        if (runFile) {
          try {
            fs.unlinkSync(runFile);
          } catch {
            /* already gone */
          }
        }
        // Best-effort removal of the ephemeral output dir; guarded to stay within currentPath.
        if (
          run.runDir &&
          appConfig.currentPath &&
          isWithin(appConfig.currentPath, run.runDir)
        ) {
          try {
            if (fs.existsSync(run.runDir))
              fs.rmSync(run.runDir, { recursive: true, force: true });
          } catch (rmErr) {
            console.warn(
              "Failed to remove output directory during delete:",
              rmErr
            );
          }
        }
      }

      // Remove DB record
      deleteReportRecord(folderName);
      invalidateReportSize(folderName);
      deleteAnalysisRunsByReport(reportUuid);
      purgeReportDigests(reportUuid);

      res.json({ success: true });
    } catch (error: any) {
      console.error("Delete error:", error);
      res
        .status(500)
        .json({ error: "Failed to delete report: " + error.message });
    }
  });

  // Update report metadata endpoint
  app.post("/api/report-metadata", (req: Request, res: Response): any => {
    const { reportId, metadata } = req.body;
    if (!reportId) return res.status(400).json({ error: "reportId is required" });
    if (metadata === undefined)
      return res.status(400).json({ error: "metadata is required" });

    try {
      const existing = getReport(reportId);
      if (!existing)
        return res.status(404).json({ error: "Report not found in database" });

      updateReportMetadata(reportId, metadata);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Metadata update error:", error);
      res
        .status(500)
        .json({ error: "Failed to update metadata: " + error.message });
    }
  });

  // Rename report endpoint (renames folder on disk + updates DB id/path)
  app.post("/api/report-rename", (req: Request, res: Response): any => {
    refreshConfigCache();
    const { reportId, newName } = req.body;
    if (!reportId) return res.status(400).json({ error: "reportId is required" });
    if (!newName || typeof newName !== "string")
      return res.status(400).json({ error: "newName is required" });

    const trimmed = newName.trim();
    if (!trimmed)
      return res.status(400).json({ error: "newName cannot be empty" });
    if (/[/\\:*?"<>|\x00]/.test(trimmed))
      return res
        .status(400)
        .json({ error: "newName contains invalid characters" });
    if (trimmed === "." || trimmed === "..")
      return res
        .status(400)
        .json({ error: "newName is not a valid folder name" });

    try {
      const existing = getReport(reportId);
      if (!existing)
        return res.status(404).json({ error: "Report not found in database" });
      if (!existing.reportPath.startsWith("/reports/current/"))
        return res
          .status(400)
          .json({ error: "Only current reports can be renamed" });
      if (!appConfig.currentPath)
        return res
          .status(400)
          .json({ error: "Current directory is not configured" });

      const oldFolder = path.resolve(appConfig.currentPath, reportId);
      const newFolder = path.resolve(appConfig.currentPath, trimmed);

      // Path traversal guard
      const base = path.resolve(appConfig.currentPath);
      if (!oldFolder.startsWith(base + path.sep) && oldFolder !== base)
        return res.status(400).json({ error: "Invalid report path" });
      if (!newFolder.startsWith(base + path.sep) && newFolder !== base)
        return res.status(400).json({ error: "Invalid new name" });

      if (!fs.existsSync(oldFolder))
        return res.status(404).json({ error: "Report folder not found on disk" });
      if (fs.existsSync(newFolder))
        return res
          .status(409)
          .json({ error: `A report named "${trimmed}" already exists` });

      const newReportPath = moveReportFolder(existing, trimmed, appConfig.currentPath, "current");

      res.json({ success: true, newId: trimmed, newPath: newReportPath });
    } catch (error: any) {
      console.error("Rename error:", error);
      res
        .status(error instanceof ArtifactError ? 409 : 500)
        .json({ error: "Failed to rename report: " + error.message });
    }
  });
}

