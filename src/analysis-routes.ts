import type { Express } from "express";
import { Request, Response } from "express";
import fs from "fs";
import { randomUUID } from "node:crypto";
import path from "path";
import {
  analyzeFailures,
  type AnalysisResult,
  type AnalysisRunIdentity,
  type AnalyzeRunSummary,
  AI_ANALYSIS_FILENAME,
  copilotAccessCheck,
  CopilotAnalysisError,
  copilotModels,
  FailureAnalysisError,
  type FailureManifest,
  isAnalyzableEntry,
  withCopilotAnalysisClient,
} from "@andrii_kremlovskyi/playwright-failure-analyzer";
import { getReportMetadata } from "@andrii_kremlovskyi/playwright-traces-reader";
import {
  addAnalysisRun,
  deleteAnalysisRunIds,
  getAllAnalysisRuns,
  getAnalysisRuns,
  getReport,
} from "./db";
import {
  analysisInventory,
  ArtifactError,
  assertOwnedPath,
  removeAnalysisArtifacts,
  reportArtifactRoot,
} from "./report-artifacts";
import {
  assertReportInstance,
  parseDashboardReportPath,
} from "./report-storage";
import {
  activeFailureAnalyses,
  appConfig,
  broadcastJson,
  refreshConfigCache,
  reportIsBusy,
} from "./runtime";
import {
  PREPARATION_WORKERS,
  withReportPreparation,
} from "./report-preparation";
import { reconcileReportAnalyses } from "./analysis-storage";

export function registerAnalysisRoutes(app: Express): void {
  // Header-chip preflight: access only. Model discovery belongs to Preferences.
  app.get(
    "/api/copilot-status",
    async (_req: Request, res: Response): Promise<any> => {
      refreshConfigCache();
      try {
        const status = await copilotAccessCheck(
          appConfig.copilotToken || undefined,
        );
        res.json(status);
      } catch (error: any) {
        res.json({
          ok: false,
          authenticated: false,
          error: error?.message || String(error),
        });
      }
    },
  );

  app.get(
    "/api/copilot-models",
    async (_req: Request, res: Response): Promise<any> => {
      refreshConfigCache();
      const result = await copilotModels(appConfig.copilotToken || undefined);
      res.json({
        ...result,
        smallModel: appConfig.copilotModel,
        bigModel: appConfig.copilotBigModel,
      });
    },
  );

  // The shared engine owns the bundle; the dashboard owns its lifecycle and UI.
  app.post(
    "/api/failures",
    async (req: Request, res: Response): Promise<any> => {
      refreshConfigCache();
      const { reportPath, replaceRunId, analysisVersion } = req.body;
      if (!reportPath)
        return res.status(400).json({ error: "reportPath is required" });

      // Determine which base directory this report lives in (current vs archive)
      const isArchive = reportPath.startsWith("/reports/archive/");
      const basePath = isArchive
        ? appConfig.archivePath
        : appConfig.currentPath;
      if (!basePath)
        return res.status(400).json({ error: "Base directory not configured" });

      // Extract the report folder name from the URL path
      // e.g. /reports/current/my-test-run/index.html -> my-test-run
      const urlParts = reportPath.split("/");
      if (urlParts.length < 4)
        return res.status(400).json({ error: "Invalid report path format" });
      const folderName = urlParts[3];

      const reportRootPath = path.join(basePath, folderName);
      if (!fs.existsSync(reportRootPath)) {
        return res
          .status(404)
          .json({ error: "Report folder not found on disk" });
      }
      if (!appConfig.currentPath)
        return res
          .status(400)
          .json({ error: "Current directory not configured" });

      const report = getReport(folderName);
      if (
        !report ||
        report.reportPath !== reportPath ||
        !parseDashboardReportPath(reportPath)
      )
        return res
          .status(404)
          .json({ error: "Report not found in the report index." });
      const analysisKey = report.uuid;
      if (activeFailureAnalyses.has(analysisKey)) {
        return res.status(409).json({
          code: "FAILURE_ANALYSIS_IN_PROGRESS",
          error: "Failure analysis is already running for this report.",
        });
      }
      const config = appConfig;
      const previousRuns = getAnalysisRuns(report.uuid);
      const inventory = analysisInventory(config, previousRuns);
      if (inventory.needsReview)
        return res.status(409).json({
          code: "ANALYSIS_REVIEW_REQUIRED",
          error:
            "Review the existing analysis data in Report Info before rerunning.",
          inventory,
          reportId: report.id,
        });
      if (
        previousRuns.length &&
        (replaceRunId !== previousRuns[0].id ||
          analysisVersion !== inventory.version)
      )
        return res.status(409).json({
          code: "ANALYSIS_REPLACEMENT_REQUIRED",
          error: "Confirm deletion of the previous analysis before rerunning.",
          inventory,
          runId: previousRuns[0].id,
        });
      if (!previousRuns.length && replaceRunId)
        return res.status(409).json({
          code: "ANALYSIS_CHANGED",
          error: "The previous analysis changed. Refresh and try again.",
        });
      activeFailureAnalyses.add(analysisKey);
      const broadcastProgress = (progress: object) =>
        broadcastJson("failure-analysis", {
          reportUuid: report.uuid,
          ...progress,
        });
      let generationRoot = "";
      let persisted = false;
      try {
        const result = await withCopilotAnalysisClient(
          {
            smallModel: config.copilotModel,
            bigModel: config.copilotBigModel,
          },
          config.copilotToken || undefined,
          async (client) => {
            const outputDir = reportArtifactRoot(
              config.currentPath,
              report.uuid,
              "analysis",
            );
            const allowedChildren = inventory.entries
              .flatMap((entry) => [
                ...(entry.output ? [entry.output.path] : []),
                ...entry.notes.map((note) => note.path),
              ])
              .filter((file) => path.dirname(file) === outputDir)
              .map((file) => path.basename(file));
            if (
              fs.existsSync(outputDir) &&
              fs
                .readdirSync(outputDir)
                .some((name) => !allowedChildren.includes(name))
            )
              throw new ArtifactError(
                "ANALYSIS_REVIEW_REQUIRED",
                `Untracked analysis output requires review: ${outputDir}`,
              );
            if (getReport(report.id)?.uuid !== report.uuid)
              throw new ArtifactError(
                "ANALYSIS_CHANGED",
                "The report changed while preparing analysis.",
              );
            assertReportInstance(report, report.uuid, reportPath);
            await getReportMetadata(reportRootPath);
            assertReportInstance(report, report.uuid, reportPath);
            if (previousRuns.length) {
              if (previousRuns.some((run) => run.storageVersion !== 1)) {
                const migrated = reconcileReportAnalyses(config, report.id);
                if (migrated.issues.length)
                  throw new ArtifactError(
                    "ANALYSIS_REVIEW_REQUIRED",
                    migrated.issues.join("\n"),
                  );
                throw new ArtifactError(
                  "ANALYSIS_REPLACEMENT_REQUIRED",
                  "Legacy notes were safely copied into managed storage. Confirm the updated paths before replacement.",
                );
              }
              const removed = removeAnalysisArtifacts(
                config,
                getAnalysisRuns(report.uuid),
                analysisVersion,
                undefined,
                getAllAnalysisRuns().filter(
                  (run) => run.reportId !== report.uuid,
                ),
              );
              deleteAnalysisRunIds(report.uuid, removed);
            }
            if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length)
              throw new ArtifactError(
                "ANALYSIS_REVIEW_REQUIRED",
                `Unexpected files remain in ${outputDir}`,
              );
            fs.mkdirSync(outputDir, { recursive: true });
            generationRoot = outputDir;

            const registerRun = (run: AnalysisRunIdentity) => {
              assertOwnedPath(outputDir, run.runDir);
              assertReportInstance(report, report.uuid, reportPath);
              addAnalysisRun({
                id: randomUUID(),
                reportId: report.uuid,
                runDir: run.runDir,
                runName: run.runId,
                createdAt: run.createdAt,
                groupedAnalysisPath: fs.existsSync(
                  path.join(run.runDir, "grouped-analysis.md"),
                )
                  ? path.join(run.runDir, "grouped-analysis.md")
                  : "",
              });
              persisted = true;
            };
            let manifest: FailureManifest | undefined;
            let analysis: AnalysisResult;
            try {
              analysis = await analyzeFailures({
                reportPath: reportRootPath,
                outputDir,
                smallModel: config.copilotModel,
                bigModel: config.copilotBigModel,
                client,
                workers: PREPARATION_WORKERS,
                context: {
                  source: {
                    kind: "playwright-reports",
                    reportUuid: report.uuid,
                    reportName: report.id,
                  },
                },
                schedulePreparation: (prepare) =>
                  withReportPreparation(() => {
                    assertReportInstance(report, report.uuid, reportPath);
                    broadcastProgress({ phase: "digest" });
                    return prepare();
                  }),
                onPrepared: (run) => {
                  registerRun(run);
                  manifest = run.manifest;
                  broadcastProgress({
                    phase: "start",
                    total: manifest.failures.filter(isAnalyzableEntry).length,
                  });
                },
                onProgress: (event) => {
                  if (event.phase === "preparation")
                    broadcastProgress({ phase: "queued" });
                  else if (event.phase === "analysis")
                    broadcastProgress({ phase: "progress", ...event.progress });
                  else if (event.phase === "grouping")
                    broadcastProgress({ phase: "grouping-start" });
                },
              });
            } catch (error) {
              if (
                !persisted &&
                error instanceof FailureAnalysisError &&
                error.result.errors[0]?.stage === "preparation"
              )
                registerRun(error.result);
              throw error;
            }
            if (!manifest) {
              if (!persisted) registerRun(analysis);
              throw new FailureAnalysisError(
                analysis,
                new Error("Analysis did not produce a valid manifest."),
              );
            }
            const relativeRunDir = path
              .relative(config.currentPath, analysis.runDir)
              .split(path.sep)
              .join("/");
            const ai: AnalyzeRunSummary = {
              total: analysis.attempts.total,
              analyzed: analysis.attempts.analyzed,
              failed: analysis.attempts.unavailable,
              skipped: analysis.attempts.excluded,
              omitted: analysis.attempts.omitted,
              analysisFileName: AI_ANALYSIS_FILENAME,
            };
            const aiError =
              analysis.errors.find(
                (error) =>
                  error.stage !== "grouping" && error.code !== "ATTEMPT_FAILED",
              )?.message ?? null;
            const groupingError =
              analysis.errors.find((error) => error.stage === "grouping")
                ?.message ?? null;
            const groupedFile = analysis.artifacts.groupedAnalysis;
            reconcileReportAnalyses(config, report.id);
            const grouping = groupedFile
              ? {
                  problemCount: analysis.grouping.problemCount,
                  fileName: groupedFile,
                  relativePath: `${relativeRunDir}/${groupedFile}`,
                  url: `/reports/current/${relativeRunDir}/${groupedFile}`,
                }
              : null;
            broadcastProgress({ phase: "complete", ...ai });
            if (grouping)
              broadcastProgress({
                phase: "grouping-complete",
                problemCount: grouping.problemCount,
              });
            else if (groupingError)
              broadcastProgress({
                phase: "grouping-failed",
                error: groupingError,
              });
            return {
              success:
                analysis.status === "complete" ||
                analysis.status === "no-failures",
              status: analysis.status,
              count: manifest.count,
              runDir: analysis.runDir,
              relativeRunDir,
              failuresUrl: `/reports/current/${relativeRunDir}/index.json`,
              manifest,
              coverage: analysis.coverage,
              warnings: [...new Set(analysis.warnings)],
              ai,
              aiError,
              grouping,
              groupingDiagnostics: analysis.grouping.diagnostics ?? null,
              groupingError,
              analysisResult: analysis,
            };
          },
        );
        res.json(result);
      } catch (error: any) {
        if (generationRoot && !persisted) {
          try {
            fs.rmSync(generationRoot, { recursive: true, force: true });
          } catch (cleanupError) {
            console.error("Failed to clean incomplete analysis:", cleanupError);
          }
        }
        console.error("Failures endpoint error:", error);
        broadcastProgress({ phase: "failed", error: error.message });
        const cause =
          error instanceof FailureAnalysisError ? error.cause : error;
        if (cause instanceof ArtifactError)
          return res.status(409).json({
            code: cause.code,
            error: cause.message,
            reportId: report.id,
            inventory: analysisInventory(config, getAnalysisRuns(report.uuid)),
            runId: getAnalysisRuns(report.uuid)[0]?.id,
          });
        if (error instanceof CopilotAnalysisError) {
          const status = error.code === "COPILOT_NOT_AUTHENTICATED" ? 401 : 409;
          return res.status(status).json({
            code: error.code,
            error: error.message,
            model: error.model,
            modelRole: error.modelRole,
          });
        }
        res.status(500).json({
          error: "Failed to analyze failures: " + error.message,
          ...(error instanceof FailureAnalysisError
            ? { analysisResult: error.result }
            : {}),
        });
      } finally {
        activeFailureAnalyses.delete(analysisKey);
      }
    },
  );

  app.post("/api/analysis/consolidate", (req: Request, res: Response): any => {
    refreshConfigCache();
    const { reportId, keepRunId, version } = req.body;
    const report = getReport(reportId);
    if (!report) return res.status(404).json({ error: "Report not found." });
    if (!keepRunId || !version)
      return res
        .status(400)
        .json({ error: "Select an analysis and confirm the reviewed files." });
    if (reportIsBusy(report.uuid))
      return res
        .status(409)
        .json({ error: "This report has an active operation." });
    try {
      const removed = removeAnalysisArtifacts(
        appConfig,
        getAnalysisRuns(report.uuid),
        version,
        keepRunId,
        getAllAnalysisRuns().filter((run) => run.reportId !== report.uuid),
      );
      deleteAnalysisRunIds(report.uuid, removed);
      return res.json({ success: true });
    } catch (error: any) {
      return res
        .status(error instanceof ArtifactError ? 409 : 500)
        .json({ code: error.code, error: error.message });
    }
  });
}
