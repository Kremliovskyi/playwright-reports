import fs from "node:fs";
import path from "node:path";
import {
  getAllAnalysisRuns,
  getAnalysisRuns,
  getReport,
  type AnalysisRun,
} from "./db";
import { ArtifactError } from "./report-artifacts";
import { resolveFinal, resolveGrouped } from "./analysis-storage";
import { appConfig } from "./runtime";

export function resolveLegacyRun(filename: string): AnalysisRun | undefined {
  if (path.basename(filename) !== filename)
    throw new ArtifactError("UNSAFE_ARTIFACT_PATH", "Invalid analysis name.");
  const name = filename.replace(/\.md$/, "");
  const runs = getAllAnalysisRuns().filter((run) => run.runName === name);
  if (runs.length > 1)
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      "This name belongs to multiple analyses. Use the report-scoped link in Info.",
    );
  return runs[0];
}

export const resolveVaultFile = (filename: string): string | null => {
  const run = resolveLegacyRun(filename);
  return run ? resolveFinal(appConfig, run) : null;
};

export const getReportAnalysisFiles = (
  reportId: string,
): {
  files: { runName: string; mtime: string; runDir: string }[];
  issues: string[];
} => {
  const report = getReport(reportId);
  if (!report) return { files: [], issues: [] };
  const issues: string[] = [];
  const files = getAnalysisRuns(report.uuid).flatMap((run) => {
    try {
      const file = resolveFinal(appConfig, run);
      return file
        ? [
            {
              runName: run.runName,
              mtime: fs.statSync(file).mtime.toISOString(),
              runDir: run.runDir,
            },
          ]
        : [];
    } catch (error) {
      if (!(error instanceof ArtifactError)) throw error;
      issues.push(`${run.runName}: ${error.message}`);
      return [];
    }
  });
  return { files, issues };
};

export function scopedAnalysisRun(
  reportId: string,
  runName: string,
): AnalysisRun | undefined {
  const report = getReport(reportId);
  return (
    report &&
    getAnalysisRuns(report.uuid).find((run) => run.runName === runName)
  );
}

export const resolveGroupedAnalysisFile = (
  reportId: string,
  runName: string,
): string | null => {
  const run = scopedAnalysisRun(reportId, runName);
  return run ? resolveGrouped(appConfig, run) : null;
};
