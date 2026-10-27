import fs from "fs";
import path from "path";
import {
  deleteAnalysisRunsByReport,
  deleteDigestsByReport,
  getAnalysisRuns,
  getDigests,
  getReport,
  ReportRecord,
  updateReportId
} from "./db";
import {
  ArtifactError,
  assertOwnedPath
} from "./report-artifacts";
import { appConfig, invalidateReportSize } from "./runtime";

export type ReportScope = "current" | "archive";

export const parseDashboardReportPath = (
  reportPath: string
): { scope: ReportScope; folderName: string } | null => {
  const match = reportPath.match(/^\/reports\/(current|archive)\/([^/]+)\/index\.html$/);
  if (!match) return null;
  return { scope: match[1] === "archive" ? "archive" : "current", folderName: match[2] };
};

export const getBasePathForScope = (scope: ReportScope): string | null =>
  (scope === "current" ? appConfig.currentPath : appConfig.archivePath) || null;

// Remove a report instance's analysis runs: best-effort delete of each ephemeral output dir
// (guarded to stay within currentPath) followed by the DB rows. Used by scanDirectory when a
// report folder is regenerated (new birthtime) or disappears from disk.
export const purgeReportRuns = (reportUuid: string): void => {
  if (!reportUuid) return;
  for (const run of getAnalysisRuns(reportUuid)) {
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
          "Failed to remove output directory during scan cleanup:",
          rmErr
        );
      }
    }
  }
  deleteAnalysisRunsByReport(reportUuid);
  purgeReportDigests(reportUuid);
};

// Remove a report instance's trace digests: best-effort delete of each digest run directory
// (guarded to stay within currentPath) followed by the DB rows. Mirrors purgeReportRuns.
export const purgeReportDigests = (reportUuid: string): void => {
  if (!reportUuid) return;
  for (const digest of getDigests(reportUuid)) {
    if (
      digest.runDir &&
      appConfig.currentPath &&
      isWithin(appConfig.currentPath, digest.runDir)
    ) {
      try {
        if (fs.existsSync(digest.runDir))
          fs.rmSync(digest.runDir, { recursive: true, force: true });
      } catch (rmErr) {
        console.warn(
          "Failed to remove digest directory during cleanup:",
          rmErr
        );
      }
    }
  }
  deleteDigestsByReport(reportUuid);
};

// Auto-archive report endpoint
export const assertReportInstance = (
  report: ReportRecord,
  expectedUuid?: unknown,
  expectedPath?: unknown
): string => {
  if (
    (expectedUuid !== undefined && expectedUuid !== report.uuid) ||
    (expectedPath !== undefined && expectedPath !== report.reportPath)
  )
    throw new ArtifactError("REPORT_CHANGED", "The report identity changed. Refresh before trying again.");
  const parsed = parseDashboardReportPath(report.reportPath);
  const base = parsed && getBasePathForScope(parsed.scope);
  if (!base || !parsed || parsed.folderName !== report.id)
    throw new ArtifactError("REPORT_CHANGED", "Report storage is unavailable. Refresh before trying again.");
  const source = path.resolve(base, report.id);
  assertOwnedPath(base, source);
  const stat = fs.statSync(source);
  if (!stat.isDirectory() || stat.birthtime.toISOString() !== report.folderBirthtime)
    throw new ArtifactError("REPORT_CHANGED", "The report folder was replaced. Refresh before trying again.");
  return source;
};

export const assertCurrentReportSource = (report: ReportRecord): string => {
  if (!report.reportPath.startsWith("/reports/current/"))
    throw new ArtifactError("REPORT_CHANGED", "Only current reports can be moved.");
  return assertReportInstance(report);
};

export const moveReportFolder = (
  report: ReportRecord,
  newId: string,
  destinationRoot: string,
  scope: "current" | "archive"
): string => {
  const source = assertCurrentReportSource(report);
  const destination = path.resolve(destinationRoot, newId);
  assertOwnedPath(destinationRoot, destination);
  if (fs.existsSync(destination) || getReport(newId))
    throw new ArtifactError("REPORT_MOVE_CONFLICT", `A report named "${newId}" already exists.`);
  const newPath = `/reports/${scope}/${newId}/index.html`;
  let moved = false;
  let copied = false;
  let removingSource = false;
  try {
    try {
      fs.renameSync(source, destination);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      copied = true;
      fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
      removingSource = true;
      fs.rmSync(source, { recursive: true });
    }
    updateReportId(report.id, newId, newPath, fs.statSync(destination).birthtime.toISOString());
  } catch (error) {
    try {
      if (copied) {
        if (removingSource) fs.cpSync(destination, source, { recursive: true });
        fs.rmSync(destination, { recursive: true, force: true });
      } else if (moved) {
        fs.renameSync(destination, source);
      }
      if (copied || moved)
        updateReportId(report.id, report.id, report.reportPath, fs.statSync(source).birthtime.toISOString());
    } catch (rollbackError) {
      throw new Error(`${String(error)}\nReport move rollback failed: ${String(rollbackError)}`);
    }
    throw error;
  }
  invalidateReportSize(report.id);
  invalidateReportSize(newId);
  return newPath;
};

// True when `target` resolves to `base` itself or a path nested inside it.
export const isWithin = (base: string, target: string): boolean => {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  return (
    resolvedTarget === resolvedBase ||
    resolvedTarget.startsWith(resolvedBase + path.sep)
  );
};

// Resolve a report's physical folder on disk from its DB record.
export const resolveReportFolder = (report: ReportRecord): string | null => {
  const isArchive = report.reportPath.startsWith("/reports/archive/");
  const base = isArchive ? appConfig.archivePath : appConfig.currentPath;
  if (!base) return null;
  return path.join(base, report.id);
};
