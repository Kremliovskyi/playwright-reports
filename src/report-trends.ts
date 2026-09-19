import AdmZip from "adm-zip";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertOwnedPath } from "./report-artifacts";
import type { ReportRecord } from "./db";
import type {} from "./public/trends-types";

const statuses = new Set([
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
]);
const outcomes = new Set(["expected", "unexpected", "flaky", "skipped"]);
const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const validDuration = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const timestamp = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const relativeFile = (value: string): string => {
  const normalized = value.replace(/\\/g, "/");
  return /^(?:\/|[A-Za-z]:\/)/.test(normalized)
    ? path.posix.basename(normalized)
    : normalized;
};

export function normalizeSuiteTitle(title: string): string {
  return title.replace(
    /\[([A-Z][A-Z0-9_-]* [A-Z][A-Z0-9_-]*) - \d{1,2}\/\d{1,2}(?:\/\d{2,4})?\]$/,
    "[$1]",
  );
}

export function parseTrendReport(
  html: string,
  report: TrendData.Report,
): TrendData.Series[] {
  const encoded =
    html.match(/window\.playwrightReportBase64\s*=\s*["']([^"']+)["']/)?.[1] ??
    html.match(
      /<(?:script|template)\b[^>]*\bid=["']playwrightReportBase64["'][^>]*>([^<]+)<\/(?:script|template)>/,
    )?.[1];
  if (!encoded)
    throw new Error("Unsupported report: embedded report data is missing.");
  const zip = new AdmZip(
    Buffer.from(
      encoded.trim().replace(/^data:application\/zip;base64,/, ""),
      "base64",
    ),
  );
  const readJson = (name: string): any => {
    const entry = zip.getEntry(name);
    if (!entry || entry.header.size > 64 * 1024 * 1024)
      throw new Error(
        "Report detail is missing or exceeds the 64 MB entry limit.",
      );
    return JSON.parse(zip.readAsText(entry));
  };
  const summary = readJson("report.json");
  if (!Array.isArray(summary.files))
    throw new Error("Unsupported report summary.");
  const series: TrendData.Series[] = [];
  const seenIds = new Set<string>();
  for (const file of summary.files) {
    if (typeof file.fileId !== "string" || !Array.isArray(file.tests))
      throw new Error("Unsupported report file entry.");
    const detail = readJson(`${file.fileId}.json`);
    if (!Array.isArray(detail.tests))
      throw new Error("Unsupported test details.");
    const details = new Map<string, any>();
    for (const test of detail.tests) {
      if (typeof test.testId !== "string" || details.has(test.testId))
        throw new Error("Duplicate or missing report test ID.");
      details.set(test.testId, test);
    }
    for (const item of file.tests) {
      const test = details.get(item.testId);
      if (
        !test ||
        typeof test.title !== "string" ||
        typeof test.projectName !== "string" ||
        typeof test.location?.file !== "string" ||
        !Array.isArray(test.path) ||
        !test.path.every((part: unknown) => typeof part === "string") ||
        !Array.isArray(test.results) ||
        !outcomes.has(test.outcome) ||
        seenIds.has(test.testId)
      )
        throw new Error("Incomplete or ambiguous test details.");
      seenIds.add(test.testId);
      const attempts: TrendData.Attempt[] = test.results.map(
        (result: any, index: number) => {
          if (
            !statuses.has(result.status) ||
            !validDuration(result.duration) ||
            !Number.isInteger(result.retry) ||
            result.retry < 0
          )
            throw new Error("Invalid attempt timing or status.");
          return {
            index,
            retry: result.retry,
            startTime: timestamp(result.startTime),
            duration: result.duration,
            status: result.status,
          };
        },
      );
      const total = attempts.reduce(
        (sum, attempt) => sum + attempt.duration,
        0,
      );
      if (
        !validDuration(test.duration) ||
        Math.abs(test.duration - total) > 0.01 ||
        !validDuration(item.duration) ||
        Math.abs(item.duration - total) > 0.01
      )
        throw new Error("Attempt timings do not match the report total.");
      const rawRepeat = test.repeatEachIndex;
      const repeat = rawRepeat ?? 0;
      if (
        !Number.isInteger(repeat) ||
        repeat < 0 ||
        rawRepeat === null ||
        item.repeatEachIndex !== rawRepeat
      )
        throw new Error("Invalid repeat index.");
      const sourceFile = test.location.file.replace(/\\/g, "/");
      const line =
        Number.isInteger(test.location.line) && test.location.line > 0
          ? test.location.line
          : null;
      const column =
        Number.isInteger(test.location.column) && test.location.column > 0
          ? test.location.column
          : null;
      const definition = hash(
        JSON.stringify([
          test.projectName,
          sourceFile,
          test.path,
          test.title,
          line,
          column,
        ]),
      );
      const normalizedPath = test.path.map(normalizeSuiteTitle);
      const spec = relativeFile(test.location.file);
      const key = hash(
        JSON.stringify([
          1,
          test.projectName,
          test.location.file.replace(/\\/g, "/"),
          normalizedPath,
          test.title,
          repeat,
        ]),
      );
      series.push({
        key,
        title: test.title,
        path: normalizedPath,
        file: spec,
        project: test.projectName,
        repeat,
        ambiguous: false,
        observations: [
          {
            id: hash(JSON.stringify([report.uuid, test.testId])),
            definition,
            reportUuid: report.uuid,
            testId: test.testId,
            title: test.title,
            file: sourceFile,
            line,
            column,
            project: test.projectName,
            repeat: rawRepeat ?? null,
            path: [...test.path],
            outcome: test.outcome,
            attempts,
            passed:
              [...attempts]
                .reverse()
                .find((attempt) => attempt.status === "passed")?.duration ??
              null,
            total: attempts.some((attempt) => attempt.status !== "skipped")
              ? total
              : null,
          },
        ],
      });
    }
  }
  const reportTime =
    typeof summary.startTime === "number" ? timestamp(summary.startTime) : null;
  const attemptTimes = series
    .flatMap((test) =>
      test.observations[0].attempts.map((attempt) => attempt.startTime),
    )
    .filter((value): value is string => !!value)
    .sort();
  report.timestamp = reportTime ?? attemptTimes[0] ?? report.createdAt;
  report.timeSource = reportTime
    ? "report"
    : attemptTimes.length
      ? "attempt"
      : "catalog";
  report.version = hash(html);
  return series;
}

export function mergeTrendSeries(
  entries: TrendData.Series[],
): TrendData.Series[] {
  const groups = new Map<string, TrendData.Series[]>();
  for (const series of entries) {
    const group = groups.get(series.key) ?? [];
    group.push(series);
    groups.set(series.key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const reportIds = group.map((series) => series.observations[0].reportUuid);
    if (new Set(reportIds).size !== reportIds.length)
      return group.map((series) => ({
        ...series,
        key: hash(
          JSON.stringify([
            series.key,
            series.observations[0].reportUuid,
            series.observations[0].testId,
          ]),
        ),
        ambiguous: true,
      }));
    return [
      {
        ...group[0],
        observations: group.flatMap((series) => series.observations),
      },
    ];
  });
}

export function describeTrendReport(record: ReportRecord): TrendData.Report {
  return {
    uuid: record.uuid,
    name: record.id,
    metadata: record.metadata,
    createdAt: record.dateCreated,
    timestamp: record.dateCreated,
    timeSource: "catalog",
    scope: record.reportPath.startsWith("/reports/archive/")
      ? "archive"
      : "current",
    version: "",
  };
}

export class TrendSourceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readTrendSource(
  root: string,
  folder: string,
  record: ReportRecord,
): Promise<string> {
  const directory = path.join(root, folder);
  const index = path.join(directory, "index.html");
  assertOwnedPath(root, index);
  const directoryStat = await fs.stat(directory);
  if (directoryStat.birthtime.toISOString() !== record.dateCreated)
    throw new TrendSourceError(
      409,
      "Report was replaced. Search matches again.",
    );
  const before = await fs.stat(index);
  if (!before.isFile() || before.size > 128 * 1024 * 1024)
    throw new TrendSourceError(400, "Report exceeds the 128 MB input limit.");
  const html = await fs.readFile(index, "utf8");
  const after = await fs.stat(index);
  if (
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  )
    throw new TrendSourceError(
      409,
      "Report changed while reading. Search matches again.",
    );
  return html;
}
