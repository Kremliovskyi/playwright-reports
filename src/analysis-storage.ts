import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  getAllAnalysisRuns,
  getAnalysisRuns,
  getReport,
  getReportByUuid,
  updateAnalysisArtifacts,
  type AnalysisRun,
} from "./db";
import {
  analysisInventory,
  artifactPathsOverlap,
  analysisNoteLocations,
  ArtifactError,
  assertOwnedPath,
  contentVersion,
  FINAL_ANALYSIS_FILENAME,
  groupedAnalysisLocation,
  retainedAnalysisRoot,
  type ArtifactRoots,
} from "./report-artifacts";

export function resolveFinal(
  roots: ArtifactRoots,
  run: AnalysisRun,
): string | null {
  const locations = analysisNoteLocations(roots, run);
  const files = [
    ...new Set(
      locations
        .filter((item) => fs.existsSync(item.path))
        .map((item) => item.path),
    ),
  ];
  if (files.length > 1)
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      `Multiple final files exist for ${run.runName}. Review them before continuing.`,
    );
  if (files[0] && !fs.statSync(files[0]).isFile())
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      "The final analysis is not a regular file.",
    );
  if (!files.length && run.finalAnalysisPath)
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      `Registered final is missing: ${run.finalAnalysisPath}`,
    );
  return files[0] || null;
}

export function resolveGrouped(
  roots: ArtifactRoots,
  run: AnalysisRun,
): string | null {
  const location = groupedAnalysisLocation(roots, run);
  if (!location || !fs.existsSync(location.path)) {
    if (run.groupedAnalysisPath)
      throw new ArtifactError(
        "ANALYSIS_REVIEW_REQUIRED",
        `Registered grouped analysis is missing: ${run.groupedAnalysisPath}`,
      );
    return null;
  }
  if (!fs.statSync(location.path).isFile())
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      "Grouped analysis is not a regular file.",
    );
  return location.path;
}

export function copyFinal(source: string, destination: string): boolean {
  if (path.resolve(source) === path.resolve(destination)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    if (
      contentVersion(fs.readFileSync(source, "utf8")) ===
      contentVersion(fs.readFileSync(destination, "utf8"))
    )
      return false;
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      `A different final already exists: ${destination}`,
    );
  }
  const temporary = path.join(
    path.dirname(destination),
    `.final-${randomUUID()}`,
  );
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    if (
      contentVersion(fs.readFileSync(source, "utf8")) !==
      contentVersion(fs.readFileSync(temporary, "utf8"))
    )
      throw new ArtifactError(
        "ANALYSIS_CHANGED",
        "Final changed while being preserved.",
      );
    fs.linkSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return true;
}

export function saveFinal(
  roots: ArtifactRoots,
  run: AnalysisRun,
  content: string,
  expectedVersion: unknown,
): string {
  assertExclusiveAnalysis(roots, run);
  const current = resolveFinal(roots, run);
  if (
    current
      ? expectedVersion !== contentVersion(fs.readFileSync(current, "utf8"))
      : expectedVersion !== undefined
  )
    throw new ArtifactError(
      "ANALYSIS_CHANGED",
      "Final changed or was removed. Reload before saving.",
    );
  const migrated = reconcileAnalysis(roots, run);
  const destination =
    migrated.finalAnalysisPath || finalDestination(roots, migrated);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.final-${randomUUID()}`,
  );
  try {
    const fd = fs.openSync(temporary, "wx");
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (current) fs.renameSync(temporary, destination);
    else fs.linkSync(temporary, destination);
    if (!migrated.finalAnalysisPath) {
      try {
        updateAnalysisArtifacts({
          ...migrated,
          finalAnalysisPath: destination,
        });
      } catch (error) {
        fs.unlinkSync(destination);
        throw error;
      }
    }
    return destination;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function finalDestination(
  roots: ArtifactRoots,
  run: AnalysisRun,
): string {
  const root =
    run.runDir && fs.existsSync(run.runDir)
      ? run.runDir
      : retainedAnalysisRoot(
          roots,
          run,
          getReportByRun(run)?.reportPath.startsWith("/reports/archive/"),
        );
  const destination = path.join(root, FINAL_ANALYSIS_FILENAME);
  assertOwnedPath(root, destination);
  return destination;
}

function getReportByRun(run: AnalysisRun) {
  // A report's public ID changes on archive/rename; the stored UUID does not.
  return getReportByUuid(run.reportId);
}

export function reconcileAnalysis(
  roots: ArtifactRoots,
  run: AnalysisRun,
): AnalysisRun {
  assertExclusiveAnalysis(roots, run);
  const final = resolveFinal(roots, run);
  const grouped = resolveGrouped(roots, run);
  let destination = final;
  const report = getReportByRun(run);
  let created = false;
  if (
    final &&
    !run.finalAnalysisPath &&
    !report?.reportPath.startsWith("/reports/archive/")
  ) {
    destination = finalDestination(roots, run);
    created = copyFinal(final, destination);
  }
  const updated = {
    ...run,
    finalAnalysisPath: destination || "",
    groupedAnalysisPath: grouped || "",
    storageVersion: 1,
  };
  try {
    updateAnalysisArtifacts(updated);
  } catch (error) {
    if (created && destination) fs.unlinkSync(destination);
    throw error;
  }
  return updated;
}

export function reconcileReportAnalyses(
  roots: ArtifactRoots,
  reportId: string,
): { runs: AnalysisRun[]; issues: string[] } {
  const report = getReport(reportId);
  if (!report)
    throw new ArtifactError("REPORT_CHANGED", "Report no longer exists.");
  const issues: string[] = [];
  const runs = getAnalysisRuns(report.uuid).map((run) => {
    try {
      return reconcileAnalysis(roots, run);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      return run;
    }
  });
  return { runs, issues };
}

export function assertExclusiveAnalysis(
  roots: ArtifactRoots,
  run: AnalysisRun,
): void {
  const others = getAllAnalysisRuns().filter(
    (item) => item.reportId !== run.reportId,
  );
  const inventory = analysisInventory(roots, [run]);
  if (inventory.issues.length)
    throw new ArtifactError(
      "ANALYSIS_REVIEW_REQUIRED",
      inventory.issues.join("\n"),
    );
  const paths = inventory.entries.flatMap((entry) => [
    ...(entry.output ? [entry.output.path] : []),
    ...entry.notes.map((item) => item.path),
    ...(entry.grouped ? [entry.grouped.path] : []),
  ]);
  for (const entry of analysisInventory(roots, others).entries) {
    const otherPaths = [
      ...(entry.output ? [entry.output.path] : []),
      ...entry.notes.map((item) => item.path),
      ...(entry.grouped ? [entry.grouped.path] : []),
    ];
    if (paths.some((a) => otherPaths.some((b) => artifactPathsOverlap(a, b))))
      throw new ArtifactError(
        "SHARED_ARTIFACT",
        "Another report references this analysis.",
      );
  }
}

export function preserveFinalAndDeleteOutput(
  roots: ArtifactRoots,
  run: AnalysisRun,
): void {
  assertExclusiveAnalysis(roots, run);
  const final = resolveFinal(roots, run);
  let updated = run;
  if (final) {
    const archived =
      getReportByRun(run)?.reportPath.startsWith("/reports/archive/");
    const destination = path.join(
      retainedAnalysisRoot(roots, run, archived),
      FINAL_ANALYSIS_FILENAME,
    );
    assertOwnedPath(
      archived ? roots.archivePath : roots.currentPath,
      destination,
    );
    const created = copyFinal(final, destination);
    updated = { ...run, finalAnalysisPath: destination };
    try {
      updateAnalysisArtifacts(updated);
    } catch (error) {
      if (created) fs.unlinkSync(destination);
      throw error;
    }
  }
  if (run.runDir) {
    assertOwnedPath(path.join(roots.currentPath, "tmp"), run.runDir);
    fs.rmSync(run.runDir, { recursive: true, force: true });
  }
  updateAnalysisArtifacts({ ...updated, runDir: "", groupedAnalysisPath: "" });
}
