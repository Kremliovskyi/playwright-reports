import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { getAllAnalysisRuns, getAllReports } from "./db";
import { scopedAnalysisRun, getReportAnalysisFiles } from "./vault-files";
import {
  reconcileReportAnalyses,
  resolveFinal,
  saveFinal,
} from "./analysis-storage";
import { FINAL_ANALYSIS_FILENAME } from "./report-artifacts";
import { appConfig, refreshConfigCache, reportIsBusy } from "./runtime";

export function listRegisteredFinals() {
  const issues: { reportId: string; error: string }[] = [];
  const files = getAllReports().flatMap((report) => {
    const analysis = getReportAnalysisFiles(report.id);
    issues.push(
      ...analysis.issues.map((error) => ({ reportId: report.id, error })),
    );
    return analysis.files.map((run) => {
      const query = new URLSearchParams({
        reportId: report.id,
        runName: run.runName,
      });
      return {
        filename: run.runName,
        reportId: report.id,
        reportUuid: report.uuid,
        runName: run.runName,
        mtime: run.mtime,
        url: `/api/analysis-run/final?${query}`,
      };
    });
  });
  return { files, issues };
}

export function registerFinalRoutes(
  app: Express,
  render: (
    title: string,
    content: string,
    saveUrl: string,
    sourceFile?: string,
  ) => string,
): void {
  app.post("/api/analysis/reconcile", (req: Request, res: Response) => {
    refreshConfigCache();
    const reportId = req.body?.reportId;
    if (typeof reportId !== "string")
      return res.status(400).json({ error: "reportId is required" });
    const result = reconcileReportAnalyses(appConfig, reportId);
    if (result.issues.length)
      console.warn("Analysis migration requires review:", result.issues);
    return res.status(result.issues.length ? 409 : 200).json(result);
  });

  app.get("/api/analysis/legacy", (_req, res) => {
    refreshConfigCache();
    const root = appConfig.vaultPath;
    const runs = getAllAnalysisRuns();
    const files =
      root && fs.existsSync(root)
        ? fs
            .readdirSync(root)
            .filter((name) => name.endsWith(".md"))
            .map((name) => ({
              path: path.join(root, name),
              registered: runs.some((run) => run.runName + ".md" === name),
            }))
        : [];
    res.json({
      files,
      message:
        "Legacy originals remain untouched. Unregistered files require explicit report association; they are not imported by filename guesses.",
    });
  });

  const read = (raw: boolean) => (req: Request, res: Response) => {
    refreshConfigCache();
    const reportId =
      typeof req.query.reportId === "string" ? req.query.reportId : "";
    const runName =
      typeof req.query.runName === "string" ? req.query.runName : "";
    const run = scopedAnalysisRun(reportId, runName);
    if (!run) return res.status(404).json({ error: "Analysis not found" });
    const file = resolveFinal(appConfig, run);
    if (!file)
      return res.status(404).json({ error: "Final analysis not found" });
    const content = fs.readFileSync(file, "utf8");
    const url = `/api/analysis-run/final?${new URLSearchParams({ reportId, runName })}`;
    return raw
      ? res.type("text/markdown").send(content)
      : res
          .type("html")
          .send(render(FINAL_ANALYSIS_FILENAME, content, url, file));
  };
  app.get("/api/analysis-run/final", read(true));
  app.get("/final-analysis", read(false));
  app.put("/api/analysis-run/final", (req: Request, res: Response) => {
    refreshConfigCache();
    const reportId =
      typeof req.query.reportId === "string" ? req.query.reportId : "";
    const runName =
      typeof req.query.runName === "string" ? req.query.runName : "";
    const run = scopedAnalysisRun(reportId, runName);
    if (!run) return res.status(404).json({ error: "Analysis not found" });
    if (reportIsBusy(run.reportId))
      return res.status(409).json({ error: "Analysis is busy" });
    if (typeof req.body?.content !== "string")
      return res.status(400).json({ error: "content is required" });
    const destination = saveFinal(
      appConfig,
      run,
      req.body.content,
      req.body.expectedVersion,
    );
    return res.json({ success: true, path: destination });
  });
}
