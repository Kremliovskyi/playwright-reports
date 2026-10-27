import type { Express } from "express";
import { Request, Response } from "express";
import fs from "fs";
import { randomUUID } from "node:crypto";
import path from "path";
import {
  deleteReportRecord,
  getAllReports,
  getReport,
  pruneOrphanAnalysisRuns,
  pruneOrphanDigests,
  ReportRecord,
  searchReports,
  upsertReport
} from "./db";
import { getBasePathForScope, parseDashboardReportPath, purgeReportRuns, ReportScope } from "./report-storage";
import { appConfig, invalidateReportSize, refreshConfigCache, reportIsBusy } from "./runtime";
import { getReportAnalysisFiles } from "./vault-files";

interface ReportInfo {
  id: string;
  uuid: string;
  name: string;
  path: string;
  createdAt: Date;
  modifiedAt: Date;
  metadata: string;
}

interface ScanWarning {
  code: "REPORT_SCAN_FAILED" | "REPORT_NAME_CONFLICT";
  path: string;
  message: string;
}

type AgentAnalysisType =
  | "failures"
  | "summary"
  | "network"
  | "dom"
  | "timeline";

interface AgentReportDescriptor {
  reportRef: string;
  uuid: string;
  id: string;
  name: string;
  metadata: string;
  createdAt: string;
  scope: ReportScope;
  dashboardPath: string;
  reportRootPath: string | null;
  reportDataPath: string | null;
  reportIndexPath: string | null;
  analysisFiles: string[];
  exists: {
    reportRoot: boolean;
    dataDir: boolean;
    indexHtml: boolean;
  };
}

export const AGENT_API_SCHEMA_VERSION = 1;

const getConfigStatus = () => ({
  hasCurrent: !!appConfig.currentPath,
  hasArchive: !!appConfig.archivePath,
  hasProject: !!appConfig.projectPath
});

const toReportInfo = (record: ReportRecord): ReportInfo => ({
  id: record.id,
  uuid: record.uuid,
  name: record.id,
  path: record.reportPath,
  createdAt: new Date(record.dateCreated),
  modifiedAt: new Date(record.dateCreated),
  metadata: record.metadata
});

export const getQueryString = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  return undefined;
};

const getQueryArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const parseBooleanQuery = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const parsePositiveIntegerQuery = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

const parseReportScope = (value: unknown): ReportScope | null => {
  if (value === "current" || value === "archive") return value;
  return null;
};

const encodeReportRef = (reportPath: string): string =>
  Buffer.from(reportPath, "utf8").toString("base64url");

const decodeReportRef = (reportRef: string): string | null => {
  try {
    return Buffer.from(reportRef, "base64url").toString("utf8");
  } catch {
    return null;
  }
};

const toAgentReportDescriptor = (
  record: ReportRecord
): AgentReportDescriptor => {
  const parsed = parseDashboardReportPath(record.reportPath);
  const basePath = parsed ? getBasePathForScope(parsed.scope) : null;
  const reportRootPath =
    parsed && basePath ? path.join(basePath, parsed.folderName) : null;
  const reportDataPath = reportRootPath
    ? path.join(reportRootPath, "data")
    : null;
  const reportIndexPath = reportRootPath
    ? path.join(reportRootPath, "index.html")
    : null;

  return {
    reportRef: encodeReportRef(record.reportPath),
    uuid: record.uuid,
    id: record.id,
    name: record.id,
    metadata: record.metadata,
    createdAt: record.dateCreated,
    scope: parsed?.scope || "current",
    dashboardPath: record.reportPath,
    reportRootPath,
    reportDataPath,
    reportIndexPath,
    analysisFiles: getReportAnalysisFiles(record.id).map((f) => f.runName),
    exists: {
      reportRoot: Boolean(reportRootPath && fs.existsSync(reportRootPath)),
      dataDir: Boolean(reportDataPath && fs.existsSync(reportDataPath)),
      indexHtml: Boolean(reportIndexPath && fs.existsSync(reportIndexPath))
    }
  };
};

const getReportFromRef = (reportRef: string): ReportRecord | null => {
  const decodedReportPath = decodeReportRef(reportRef);
  if (!decodedReportPath) return null;

  const parsed = parseDashboardReportPath(decodedReportPath);
  if (!parsed) return null;

  const record = getReport(parsed.folderName);
  if (!record || record.reportPath !== decodedReportPath) return null;
  return record;
};

const getPreparedReportDescriptor = (
  reportRef: string
): AgentReportDescriptor => {
  const record = getReportFromRef(reportRef);
  if (!record) {
    throw new Error("Report reference could not be resolved");
  }

  const descriptor = toAgentReportDescriptor(record);
  if (!descriptor.reportRootPath || !descriptor.reportDataPath) {
    throw new Error(
      "Report could not be prepared because its storage path is not configured"
    );
  }

  if (
    !descriptor.exists.reportRoot ||
    !descriptor.exists.indexHtml ||
    !descriptor.exists.dataDir
  ) {
    throw new Error("Report artifact is not available on local disk");
  }

  return descriptor;
};

// Helper to scan a directory for valid reports and sync with DB
const scanDirectory = (
  dirPath: string,
  prefix: string,
  warnings: ScanWarning[] = []
): ReportInfo[] => {
  if (!dirPath) return [];
  const previous = getAllReports().filter(record =>
    record.reportPath.startsWith(`/reports/${prefix}/`)
  );
  const warn = (code: ScanWarning["code"], target: string, message: string) => {
    warnings.push({ code, path: target, message });
    console.warn(message, target);
  };

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    warn("REPORT_SCAN_FAILED", dirPath, `Could not scan report directory: ${String(error)}. Existing reports were preserved.`);
    return previous.map(toReportInfo);
  }

  const reports = entries
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => {
      const folderPath = path.join(dirPath, dirent.name);
      const reportPath = `/reports/${prefix}/${dirent.name}/index.html`;
      const existing = getReport(dirent.name);
      if (existing && existing.reportPath !== reportPath) {
        warn("REPORT_NAME_CONFLICT", folderPath,
          `Another report already uses the name "${dirent.name}". Rename one folder outside the dashboard, then refresh. The indexed report and its artifacts were preserved.`);
        return null;
      }

      try {
        const stat = fs.statSync(folderPath);

        // Check if index.html exists in this folder to confirm it's a valid report
        const indexPath = path.join(folderPath, "index.html");
        const hasIndex = fs.existsSync(indexPath);
        if (!hasIndex) {
          if (existing) throw new Error("Report index.html is temporarily missing");
          return null;
        }

        // Deep inspection: verify it's actually a Playwright report
        const indexContent = fs.readFileSync(indexPath, "utf8");
        if (!indexContent.includes("<title>Playwright Test Report</title>")) {
          if (existing) throw new Error("Report index.html is incomplete or no longer a recognizable report");
          return null;
        }

        const birthIso = stat.birthtime.toISOString();

        // Look up existing DB record to preserve metadata
        const metadata = existing?.metadata || "";
        if (existing && reportIsBusy(existing.uuid))
          return toReportInfo(existing);

        // Stable per-instance identity: reuse the uuid only when the same folder name is
        // still the same physical report (matching birth time). A recycled name (e.g. a
        // deleted report recreated as the same folder) has a new birth time, so it gets a
        // fresh uuid and the old run mapping is dropped — no stale "(missing on disk)" rows.
        let uuid = existing?.uuid;
        if (!uuid || existing!.folderBirthtime !== birthIso) {
          uuid = randomUUID();
          if (existing?.uuid) purgeReportRuns(existing.uuid);
          invalidateReportSize(dirent.name);
        }
        const dateCreated = existing?.uuid === uuid ? existing.dateCreated : birthIso;

        // Upsert into DB (preserves metadata via ON CONFLICT)
        upsertReport({
          id: dirent.name,
          uuid,
          dateCreated,
          folderBirthtime: birthIso,
          metadata,
          reportPath
        });

        return {
          id: dirent.name,
          uuid,
          name: dirent.name,
          path: reportPath,
          createdAt: new Date(dateCreated),
          modifiedAt: stat.mtime,
          metadata
        };
      } catch (err) {
        warn("REPORT_SCAN_FAILED", folderPath, `Could not inspect report: ${String(err)}. Existing data was preserved.`);
        return existing ? toReportInfo(existing) : null;
      }
    })
    .filter((item): item is ReportInfo => item !== null)
    .sort(
      (a, b) =>
        new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
    );

  // Clean up stale DB entries: remove records for reports no longer on disk
  // Only absence from a successful directory listing proves that a folder disappeared.
  const diskIds = new Set(entries.map(entry => entry.name));
  const allDbReports = getAllReports();
  for (const dbReport of allDbReports) {
    // Only clean up records that belong to this prefix (check reportPath)
    if (
      dbReport.reportPath.startsWith(`/reports/${prefix}/`) &&
      !diskIds.has(dbReport.id)
    ) {
      if (reportIsBusy(dbReport.uuid)) continue;
      purgeReportRuns(dbReport.uuid);
      deleteReportRecord(dbReport.id);
      invalidateReportSize(dbReport.id);
    }
  }
  // Drop any runs left behind by recycled names whose uuid no longer exists.
  pruneOrphanAnalysisRuns();
  pruneOrphanDigests();

  return reports;
};

export function registerReportCatalog(app: Express): void {

  // API Endpoint to get the list of available reports
  app.get("/api/reports", (req, res) => {
    const warnings: ScanWarning[] = [];
    res.json({
      current: appConfig.currentPath
        ? scanDirectory(appConfig.currentPath, "current", warnings)
        : [],
      archive: appConfig.archivePath
        ? scanDirectory(appConfig.archivePath, "archive", warnings)
        : [],
      configStatus: getConfigStatus(),
      warnings
    });
  });

  app.get("/api/report-search", (req: Request, res: Response): any => {
    try {
      const query = getQueryString(req.query.query);
      const selectedDates = getQueryArray(req.query.selectedDates);
      const rangeStart = getQueryString(req.query.rangeStart);
      const rangeEnd = getQueryString(req.query.rangeEnd);

      const matchingReports = searchReports({
        query,
        selectedDates,
        rangeStart,
        rangeEnd
      });

      const current = matchingReports
        .filter((report) => report.reportPath.startsWith("/reports/current/"))
        .map(toReportInfo);
      const archive = matchingReports
        .filter((report) => report.reportPath.startsWith("/reports/archive/"))
        .map(toReportInfo);

      return res.json({
        current,
        archive,
        configStatus: getConfigStatus()
      });
    } catch (error: any) {
      console.error("Search error:", error);
      return res
        .status(400)
        .json({ error: error.message || "Failed to search reports" });
    }
  });

  app.get("/api/agent/reports/search", (req: Request, res: Response): any => {
    refreshConfigCache();

    try {
      const query = getQueryString(req.query.query);
      const selectedDates = getQueryArray(req.query.selectedDates);
      const rangeStart = getQueryString(req.query.rangeStart);
      const rangeEnd = getQueryString(req.query.rangeEnd);
      const scope = parseReportScope(req.query.scope);
      const limit = parsePositiveIntegerQuery(req.query.limit);

      let matches = searchReports({
        query,
        selectedDates,
        rangeStart,
        rangeEnd
      });

      if (scope) {
        matches = matches.filter((report) =>
          report.reportPath.startsWith(`/reports/${scope}/`)
        );
      }

      if (limit !== null) {
        matches = matches.slice(0, limit);
      }

      const reports = matches.map(toAgentReportDescriptor);

      return res.json({
        schemaVersion: AGENT_API_SCHEMA_VERSION,
        command: "search-reports",
        totalCount: reports.length,
        reports
      });
    } catch (error: any) {
      console.error("Agent search error:", error);
      return res.status(400).json({
        error: error.message || "Failed to search reports for agent workflow"
      });
    }
  });

  app.get("/api/agent/reports/prepare", (req: Request, res: Response): any => {
    refreshConfigCache();

    try {
      const reportRef = getQueryString(req.query.reportRef);
      if (!reportRef) {
        return res.status(400).json({ error: "reportRef is required" });
      }

      const report = getPreparedReportDescriptor(reportRef);
      return res.json({
        schemaVersion: AGENT_API_SCHEMA_VERSION,
        command: "prepare-report-analysis",
        mode: "local",
        report,
        analysisTarget: {
          reportRootPath: report.reportRootPath,
          reportDataPath: report.reportDataPath
        }
      });
    } catch (error: any) {
      console.error("Agent prepare error:", error);
      return res.status(404).json({
        error: error.message || "Failed to prepare report for analysis"
      });
    }
  });
}
