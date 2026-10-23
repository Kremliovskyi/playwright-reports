import fs from "fs";
import path from "path";
import {
  GROUPED_ANALYSIS_FILENAME
} from "./copilot-grouper";
import {
  getAllAnalysisRuns,
  getAnalysisRuns,
  getReport
} from "./db";
import {
  archivedGroupedAnalysisPath,
  ArtifactError,
  assertOwnedPath
} from "./report-artifacts";
import { isWithin } from "./report-storage";
import { appConfig } from "./runtime";

// --- Vault API Endpoints ---

export const resolveVaultFile = (filename: string): string | null => {
  const safeName = path.basename(filename);
  // Check vaultPath first (current reports)
  if (appConfig.vaultPath) {
    const resolved = path.resolve(appConfig.vaultPath, safeName + ".md");
    const base = path.resolve(appConfig.vaultPath);
    if (
      (resolved.startsWith(base + path.sep) || resolved === base) &&
      fs.existsSync(resolved)
    )
      return resolved;
  }
  // Check archivePath/analysis/ (archived reports)
  if (appConfig.archivePath) {
    const analysisDir = path.join(appConfig.archivePath, "analysis");
    const resolved = path.resolve(analysisDir, safeName + ".md");
    const base = path.resolve(analysisDir);
    if (
      (resolved.startsWith(base + path.sep) || resolved === base) &&
      fs.existsSync(resolved)
    )
      return resolved;
  }
  return null;
};

// Resolve the persisted failure-analysis runs for a report into existing vault files (newest first).
export const getReportAnalysisFiles = (
  reportId: string
): { runName: string; mtime: string; runDir: string }[] => {
  const files: { runName: string; mtime: string; runDir: string }[] = [];
  const reportUuid = getReport(reportId)?.uuid;
  if (!reportUuid) return files;
  for (const run of getAnalysisRuns(reportUuid)) {
    const resolved = resolveVaultFile(run.runName);
    if (!resolved) continue;
    try {
      const stat = fs.statSync(resolved);
      files.push({
        runName: run.runName,
        mtime: stat.mtime.toISOString(),
        runDir: run.runDir
      });
    } catch {
      // Skip runs whose vault file became unreadable.
    }
  }
  return files;
};

export const resolveGroupedAnalysisFile = (
  reportId: string,
  runName: string
): string | null => {
  const report = getReport(reportId);
  if (!report) return null;
  const run = getAnalysisRuns(report.uuid).find(
    (candidate) => candidate.runName === runName
  );
  if (!run) return null;
  if (report.reportPath.startsWith("/reports/archive/")) {
    const archived = archivedGroupedAnalysisPath(appConfig, runName);
    if (!archived || !fs.existsSync(archived)) return null;
    if (getAllAnalysisRuns().some((other) => other.runName === runName && other.reportId !== report.uuid))
      throw new ArtifactError("SHARED_ARTIFACT", "Another report references this grouped analysis.");
    return fs.statSync(archived).isFile() ? archived : null;
  }
  if (
    !run?.runDir ||
    !appConfig.currentPath ||
    !isWithin(appConfig.currentPath, run.runDir)
  )
    return null;
  const groupedAnalysisFile = path.join(run.runDir, GROUPED_ANALYSIS_FILENAME);
  assertOwnedPath(appConfig.currentPath, groupedAnalysisFile);
  return fs.existsSync(groupedAnalysisFile) && fs.statSync(groupedAnalysisFile).isFile() ? groupedAnalysisFile : null;
};
