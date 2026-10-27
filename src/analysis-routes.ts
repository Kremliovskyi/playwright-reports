import { spawn } from "child_process";
import type { Express } from "express";
import { Request, Response } from "express";
import fs from "fs";
import { randomUUID } from "node:crypto";
import path from "path";
import {
  analyzeRun,
  AnalyzeRunSummary,
  copilotAccessCheck,
  CopilotAnalysisError,
  copilotModels,
  FailureManifest,
  isAnalyzableEntry,
  withCopilotAnalysisClient
} from "./copilot-analyzer";
import {
  GroupingDiagnostics,
  GroupingRunError,
  groupRun
} from "./copilot-grouper";
import {
  addAnalysisRun,
  deleteAnalysisRunIds,
  getAllAnalysisRuns,
  getAnalysisRuns,
  getReport
} from "./db";
import {
  analysisInventory,
  ArtifactError,
  assertOwnedPath,
  removeAnalysisArtifacts,
  reportArtifactRoot
} from "./report-artifacts";
import { assertReportInstance, parseDashboardReportPath } from "./report-storage";
import { activeFailureAnalyses, appConfig, broadcastJson, refreshConfigCache, reportIsBusy } from "./runtime";
import { PREPARATION_WORKERS, withReportPreparation } from "./report-preparation";

export function registerAnalysisRoutes(app: Express): void {

  // Header-chip preflight: access only. Model discovery belongs to Preferences.
  app.get(
    "/api/copilot-status",
    async (_req: Request, res: Response): Promise<any> => {
      refreshConfigCache();
      try {
        const status = await copilotAccessCheck(
          appConfig.copilotToken || undefined
        );
        res.json(status);
      } catch (error: any) {
        res.json({
          ok: false,
          authenticated: false,
          error: error?.message || String(error)
        });
      }
    }
  );

  app.get(
    "/api/copilot-models",
    async (_req: Request, res: Response): Promise<any> => {
      refreshConfigCache();
      const result = await copilotModels(appConfig.copilotToken || undefined);
      res.json({
        ...result,
        smallModel: appConfig.copilotModel,
        bigModel: appConfig.copilotBigModel
      });
    }
  );

  // Failure digest endpoint — runs the playwright-traces-reader `failures` command
  app.post("/api/failures", async (req: Request, res: Response): Promise<any> => {
    refreshConfigCache();
    const { reportPath, replaceRunId, analysisVersion } = req.body;
    if (!reportPath)
      return res.status(400).json({ error: "reportPath is required" });

    // Determine which base directory this report lives in (current vs archive)
    const isArchive = reportPath.startsWith("/reports/archive/");
    const basePath = isArchive ? appConfig.archivePath : appConfig.currentPath;
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
      return res.status(404).json({ error: "Report folder not found on disk" });
    }
    if (!appConfig.currentPath)
      return res.status(400).json({ error: "Current directory not configured" });

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
        error: "Failure analysis is already running for this report."
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
        reportId: report.id
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
        runId: previousRuns[0].id
      });
    if (!previousRuns.length && replaceRunId)
      return res.status(409).json({
        code: "ANALYSIS_CHANGED",
        error: "The previous analysis changed. Refresh and try again."
      });
    activeFailureAnalyses.add(analysisKey);
    const broadcastProgress = (progress: object) =>
      broadcastJson("failure-analysis", { reportUuid: report.uuid, ...progress });
    let generationRoot = "";
    let persisted = false;
    try {
      const result = await withCopilotAnalysisClient(
        {
          smallModel: config.copilotModel,
          bigModel: config.copilotBigModel
        },
        config.copilotToken || undefined,
        async (client) => {
          const outputDir = reportArtifactRoot(
            config.currentPath,
            report.uuid,
            "analysis"
          );
          const allowedChildren = previousRuns
            .filter((run) => path.dirname(run.runDir) === outputDir)
            .map((run) => path.basename(run.runDir));
          if (
            fs.existsSync(outputDir) &&
            fs
              .readdirSync(outputDir)
              .some((name) => !allowedChildren.includes(name))
          )
            throw new ArtifactError(
              "ANALYSIS_REVIEW_REQUIRED",
              `Untracked analysis output requires review: ${outputDir}`
            );
          if (getReport(report.id)?.uuid !== report.uuid)
            throw new ArtifactError(
              "ANALYSIS_CHANGED",
              "The report changed while preparing analysis."
            );
        assertReportInstance(report, report.uuid, reportPath);
          if (previousRuns.length) {
            const removed = removeAnalysisArtifacts(
              config,
              getAnalysisRuns(report.uuid),
              analysisVersion,
              undefined,
              getAllAnalysisRuns().filter((run) => run.reportId !== report.uuid)
            );
            deleteAnalysisRunIds(report.uuid, removed);
          }
          if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length)
            throw new ArtifactError(
              "ANALYSIS_REVIEW_REQUIRED",
              `Unexpected files remain in ${outputDir}`
            );
          fs.mkdirSync(outputDir, { recursive: true });
          generationRoot = outputDir;

          const pkgMain =
            require.resolve("@andrii_kremlovskyi/playwright-traces-reader");
          const cliPath = path.join(path.dirname(pkgMain), "cli.js");
          broadcastProgress({ phase: "queued" });
          const stdout = await withReportPreparation(() => {
            assertReportInstance(report, report.uuid, reportPath);
            broadcastProgress({ phase: "digest" });
            return new Promise<string>((resolve, reject) => {
              const child = spawn(
                process.execPath,
                [
                  cliPath,
                  "failures",
                  reportRootPath,
                  outputDir,
                  "--format",
                  "json",
                  "--workers",
                  String(PREPARATION_WORKERS)
                ],
                {
                  cwd: config.currentPath
                }
              );
              let commandStdout = "";
              let commandStderr = "";
              child.stdout.on("data", (chunk) => {
                commandStdout += chunk.toString();
              });
              child.stderr.on("data", (chunk) => {
                commandStderr += chunk.toString();
              });
              child.on("error", (error) =>
                reject(
                  new Error("Failed to start failures command: " + error.message)
                )
              );
              child.on("close", (code) => {
                if (code === 0) {
                  resolve(commandStdout);
                } else {
                  reject(
                    new Error(
                      "Failures command failed: " +
                      (commandStderr.trim() ||
                        commandStdout.trim() ||
                        `exit code ${code}`)
                    )
                  );
                }
              });
            });
          });

          const manifest = JSON.parse(stdout) as FailureManifest;
          assertOwnedPath(outputDir, manifest.runDir);
          if (
            !Array.isArray(manifest.failures) ||
            !fs.existsSync(path.join(manifest.runDir, "index.json"))
          )
            throw new Error(
              "The failures command did not produce a valid analysis manifest."
            );
          if (getReport(report.id)?.uuid !== report.uuid)
            throw new ArtifactError(
              "ANALYSIS_CHANGED",
              "The report changed during analysis."
            );

          const uniqueRunDir = path.join(
            outputDir,
            `${path.basename(manifest.runDir)}-${report.uuid}`
          );
          fs.renameSync(manifest.runDir, uniqueRunDir);
          manifest.runDir = uniqueRunDir;
          fs.writeFileSync(
            path.join(uniqueRunDir, "index.json"),
            JSON.stringify(manifest, null, 2) + "\n"
          );

          const relativeRunDir = path.relative(
            config.currentPath,
            manifest.runDir
          );
          const failuresUrl = `/reports/current/${relativeRunDir.split(path.sep).join("/")}/index.json`;
          addAnalysisRun({
            id: randomUUID(),
            reportId: report.uuid,
            runDir: manifest.runDir,
            runName: path.basename(manifest.runDir),
            createdAt: new Date().toISOString()
          });
          persisted = true;

          // Run Copilot SDK per-trace analysis over the digested failures (omits Before Hooks/skipped).
          let aiSummary: AnalyzeRunSummary | null = null;
          let aiError: string | null = null;
          let grouping: {
            problemCount: number;
            fileName: string;
            relativePath: string;
            url: string;
          } | null = null;
          let groupingDiagnostics: GroupingDiagnostics | null = null;
          let groupingError: string | null = null;
          let analysisRecords: Awaited<ReturnType<typeof analyzeRun>>["records"] =
            [];
          try {
            const analyzableTotal = (manifest.failures || []).filter(
              isAnalyzableEntry
            ).length;
            broadcastProgress({
              phase: "start",
              total: analyzableTotal
            });
            const analysisResult = await analyzeRun(
              client,
              manifest.runDir,
              manifest,
              config.copilotModel,
              (p) => {
                broadcastProgress({ phase: "progress", ...p });
              }
            );
            const { records, ...summary } = analysisResult;
            analysisRecords = records;
            aiSummary = summary;
            broadcastProgress({
              phase: "complete",
              ...aiSummary
            });
          } catch (err: any) {
            aiError = err?.message || String(err);
            console.error("AI analysis failed:", err);
            broadcastProgress({
              phase: "failed",
              error: aiError
            });
          }

          const analyzableTotal = (manifest.failures || []).filter(
            isAnalyzableEntry
          ).length;
          if (analyzableTotal > 1 && analysisRecords.length > 0) {
            try {
              broadcastProgress({ phase: "grouping-start" });
              const result = await groupRun(
                client,
                manifest.runDir,
                manifest,
                analysisRecords,
                config.copilotModel,
                config.copilotBigModel
              );
              const relativePath = path
                .relative(config.currentPath, result.filePath)
                .split(path.sep)
                .join("/");
              groupingDiagnostics = result.diagnostics;
              grouping = {
                problemCount: result.problemCount,
                fileName: result.fileName,
                relativePath,
                url: `/reports/current/${relativePath}`
              };
              broadcastProgress({
                phase: "grouping-complete",
                problemCount: result.problemCount
              });
            } catch (err: any) {
              if (err instanceof GroupingRunError)
                groupingDiagnostics = err.diagnostics;
              groupingError = err?.message || String(err);
              console.error("AI problem grouping failed:", err);
              broadcastProgress({
                phase: "grouping-failed",
                error: groupingError
              });
            }
          }

          return {
            success: true,
            count: manifest.count ?? 0,
            runDir: manifest.runDir,
            relativeRunDir,
            failuresUrl,
            manifest,
            ai: aiSummary,
            aiError,
            grouping,
            groupingDiagnostics,
            groupingError
          };
        }
      );
      res.json(result);
    } catch (error: any) {
      console.error("Failures endpoint error:", error);
      if (error instanceof ArtifactError)
        return res.status(409).json({ code: error.code, error: error.message });
      if (error instanceof CopilotAnalysisError) {
        const status = error.code === "COPILOT_NOT_AUTHENTICATED" ? 401 : 409;
        return res.status(status).json({
          code: error.code,
          error: error.message,
          model: error.model,
          modelRole: error.modelRole
        });
      }
      res
        .status(500)
        .json({ error: "Failed to analyze failures: " + error.message });
    } finally {
      if (generationRoot && !persisted) {
        try {
          fs.rmSync(generationRoot, { recursive: true, force: true });
        } catch (error) {
          console.error("Failed to clean incomplete analysis:", error);
        }
      }
      activeFailureAnalyses.delete(analysisKey);
    }
  });

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
        getAllAnalysisRuns().filter((run) => run.reportId !== report.uuid)
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
