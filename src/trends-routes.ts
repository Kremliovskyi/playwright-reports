import type { Express } from "express";
import { Request, Response } from "express";
import path from "path";
import {
  getReportByUuid
} from "./db";
import {
  ArtifactError,
  contentVersion
} from "./report-artifacts";
import { getQueryString } from "./report-catalog";
import { getBasePathForScope, parseDashboardReportPath } from "./report-storage";
import {
  describeTrendReport,
  parseTrendReport,
  readTrendSource,
  resolveTrendAttempt,
  TrendSourceError
} from "./report-trends";
import { refreshConfigCache } from "./runtime";

const loadTrendSource = async (uuid: string) => {
  for (let attempt = 0;attempt < 2;attempt++) {
    const record = getReportByUuid(uuid);
    if (!record)
      throw new TrendSourceError(404, "Report is no longer available.");
    const parsed = parseDashboardReportPath(record.reportPath);
    const root = parsed && getBasePathForScope(parsed.scope);
    if (!parsed || !root)
      throw new TrendSourceError(404, "Report storage is unavailable.");
    try {
      const html = await readTrendSource(root, parsed.folderName, record);
      const current = getReportByUuid(uuid);
      if (current?.reportPath !== record.reportPath) continue;
      return { record, html };
    } catch (error) {
      if (
        getReportByUuid(uuid)?.reportPath !== record.reportPath &&
        attempt === 0
      )
        continue;
      throw error;
    }
  }
  throw new TrendSourceError(
    409,
    "Report moved while reading. Apply filters again."
  );
};

const trendError = (error: unknown): { status: number; message: string } => {
  if (error instanceof TrendSourceError)
    return { status: error.status, message: error.message };
  if (error instanceof ArtifactError)
    return {
      status: 400,
      message: "Report is outside its managed storage or uses a symbolic link."
    };
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
    return { status: 404, message: "Report is no longer available." };
  return {
    status: 422,
    message:
      "Report timing data is unreadable or unsupported. Search matches again after the report finishes writing."
  };
};

export function registerTrendsRoutes(app: Express): void {

  app.post("/api/trends", async (req: Request, res: Response): Promise<any> => {
    refreshConfigCache();
    res.setHeader("Cache-Control", "no-store");
    const ids = req.body?.reportUuids;
    const testQuery = req.body?.testQuery;
    if (
      typeof testQuery !== "string" ||
      !testQuery.trim() ||
      testQuery.trim().length > 256
    )
      return res.status(400).json({
        error: "Enter a test title or fragment (1 to 256 characters)."
      });
    if (
      !Array.isArray(ids) ||
      ids.length > 500 ||
      !ids.every(
        (uuid) =>
          typeof uuid === "string" && uuid.length > 0 && uuid.length <= 128
      )
    )
      return res.status(400).json({ error: "Select up to 500 report UUIDs." });
    const reports: TrendData.Report[] = [];
    const candidates: TrendData.Observation[] = [];
    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    for (const uuid of new Set<string>(ids)) {
      if (closed) return;
      let report = getReportByUuid(uuid);
      let descriptor = report
        ? describeTrendReport(report)
        : {
          uuid,
          name: "Unavailable report",
          metadata: "",
          createdAt: "",
          timestamp: "",
          timeSource: "catalog" as const,
          scope: "current" as const,
          version: ""
        };
      try {
        const source = await loadTrendSource(uuid);
        report = source.record;
        descriptor = describeTrendReport(report);
        const matches = parseTrendReport(source.html, descriptor)
          .flatMap((entry) => entry.observations)
          .filter((entry) =>
            entry.title.toLowerCase().includes(testQuery.trim().toLowerCase())
          );
        candidates.push(...matches);
      } catch (error) {
        descriptor.issue = trendError(error).message;
      }
      reports.push(descriptor);
    }
    if (!closed)
      return res.json({
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        testQuery: testQuery.trim(),
        reports,
        candidates
      } satisfies TrendData.Preview);
  });

  app.get(
    "/api/trends/reports/:uuid/test",
    async (req: Request, res: Response): Promise<any> => {
      refreshConfigCache();
      res.setHeader("Cache-Control", "no-store");
      const testId = getQueryString(req.query.testId);
      const version = getQueryString(req.query.version);
      const runText = getQueryString(req.query.run) ?? "0";
      if (
        !testId ||
        !version ||
        !/^[a-f0-9]{64}$/.test(version) ||
        !/^\d+$/.test(runText)
      )
        return res.status(400).type("text").send("Invalid test link.");
      try {
        const { record, html } = await loadTrendSource(String(req.params.uuid));
        if (contentVersion(html) !== version)
          throw new TrendSourceError(
            409,
            "Report has changed. Open Trends and search matches again."
          );
        const series = parseTrendReport(html, describeTrendReport(record));
        const observation = series
          .flatMap((entry) => entry.observations)
          .find((entry) => entry.testId === testId);
        const run = Number(runText);
        if (
          !observation ||
          !Number.isSafeInteger(run) ||
          !observation.attempts[run]
        )
          throw new TrendSourceError(404, "Test attempt is no longer available.");
        const parsed = parseDashboardReportPath(record.reportPath)!;
        const query = new URLSearchParams({ testId, run: String(run) });
        return res.redirect(
          302,
          `/reports/${parsed.scope}/${encodeURIComponent(parsed.folderName)}/index.html#?${query}`
        );
      } catch (error) {
        const failure = trendError(error);
        return res.status(failure.status).type("text").send(failure.message);
      }
    }
  );

  app.get(
    "/api/agent/trends/reports/:uuid/attempt",
    async (req: Request, res: Response): Promise<any> => {
      refreshConfigCache();
      res.setHeader("Cache-Control", "no-store");
      const testId = getQueryString(req.query.testId);
      const version = getQueryString(req.query.version);
      const runText = getQueryString(req.query.run);
      if (
        !testId ||
        !version ||
        !/^[a-f0-9]{64}$/.test(version) ||
        !runText ||
        !/^\d+$/.test(runText)
      )
        return res
          .status(400)
          .json({
            error: "testId, version and a non-negative run index are required."
          });
      try {
        const { record, html } = await loadTrendSource(String(req.params.uuid));
        const parsed = parseDashboardReportPath(record.reportPath)!;
        const reportRootPath = path.resolve(
          getBasePathForScope(parsed.scope)!,
          parsed.folderName
        );
        const result = await resolveTrendAttempt(
          html,
          describeTrendReport(record),
          reportRootPath,
          testId,
          version,
          Number(runText)
        );
        if (getReportByUuid(record.uuid)?.reportPath !== record.reportPath)
          throw new TrendSourceError(
            409,
            "Report moved while resolving. Search matches again."
          );
        const query = new URLSearchParams({ testId, run: runText });
        return res.json({
          schemaVersion: 1,
          command: "resolve-trend-attempt",
          ...result,
          reportUrl: `/reports/${parsed.scope}/${encodeURIComponent(parsed.folderName)}/index.html#?${query}`
        });
      } catch (error) {
        const failure = trendError(error);
        return res.status(failure.status).json({ error: failure.message });
      }
    }
  );
}
