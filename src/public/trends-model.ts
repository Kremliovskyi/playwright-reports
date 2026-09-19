namespace TrendModel {
  export function validateTestQuery(value: unknown): string | null {
    return typeof value !== "string" ||
      !value.trim() ||
      value.trim().length > 256
      ? "Enter a test title or fragment (1 to 256 characters)."
      : null;
  }

  export function review(
    preview: TrendData.Preview,
    project: string | null,
    selected: Set<string>,
    excluded: Set<string>,
  ) {
    const projects = new Set(
      preview.candidates.map((candidate) => candidate.project),
    );
    const rows = preview.reports.map((report) => {
      const candidates = preview.candidates.filter(
        (candidate) =>
          candidate.reportUuid === report.uuid && candidate.project === project,
      );
      const definitions = new Map<string, TrendData.Observation[]>();
      for (const candidate of candidates) {
        const group = definitions.get(candidate.definition) ?? [];
        group.push(candidate);
        definitions.set(candidate.definition, group);
      }
      const groups = [...definitions.entries()].map(([key, records]) => {
        const included = records.filter((record) => !excluded.has(record.id));
        const indices = included.map((record) => record.repeat ?? 0);
        const invalid =
          included.length > 1 &&
          (new Set(indices).size !== indices.length ||
            included.some(
              (record) => record.line === null || record.column === null,
            ));
        return { key, records, included, invalid };
      });
      const active = groups.filter((group) => group.included.length);
      const observations = active.flatMap((group) => group.included);
      const state =
        !selected.has(report.uuid) ||
        (candidates.length > 0 && !observations.length)
          ? "excluded"
          : report.issue
            ? "unavailable"
            : !candidates.length
              ? "missing"
              : active.length > 1 || active.some((group) => group.invalid)
                ? "conflict"
                : "ready";
      return { report, groups, observations, state };
    });
    const canGenerate =
      project !== null &&
      projects.has(project) &&
      rows.some((row) => row.state === "ready") &&
      !rows.some(
        (row) => row.state === "conflict" || row.state === "unavailable",
      );
    return { rows, canGenerate };
  }

  export function generate(
    preview: TrendData.Preview,
    project: string | null,
    selected: Set<string>,
    excluded: Set<string>,
  ): TrendData.Dataset {
    const result = review(preview, project, selected, excluded);
    if (!result.canGenerate)
      throw new Error(
        "Resolve the included report conflicts before generating.",
      );
    const rows = result.rows.filter((row) => row.state !== "excluded");
    const observations = rows.flatMap((row) => row.observations);
    if (
      new Set(observations.map((observation) => observation.id)).size !==
      observations.length
    )
      throw new Error("Duplicate execution identity.");
    return {
      schemaVersion: 2,
      generatedAt: preview.generatedAt,
      reports: rows.map((row) => row.report),
      series: [
        {
          key: "query",
          title: preview.testQuery,
          project: project!,
          path: [],
          file: "",
          repeat: 0,
          ambiguous: false,
          observations,
        },
      ],
      selection: {
        excludedReports: result.rows.filter((row) => row.state === "excluded")
          .length,
        excludedExecutions: preview.candidates.filter(
          (candidate) =>
            candidate.project === project &&
            (!selected.has(candidate.reportUuid) || excluded.has(candidate.id)),
        ).length,
      },
    };
  }

  export function dateBounds(reports: { createdAt: string }[]): {
    rangeStart: string;
    rangeEnd: string;
  } {
    const dates = reports
      .map((report) => new Date(report.createdAt))
      .filter((date) => Number.isFinite(date.getTime()))
      .map((date) => date.toISOString().slice(0, 10))
      .sort();
    return { rangeStart: dates[0] ?? "", rangeEnd: dates.at(-1) ?? "" };
  }

  export function validateFilters(filters: TrendData.Filters): string | null {
    for (const value of [filters.rangeStart, filters.rangeEnd]) {
      if (!value) continue;
      const date = new Date(`${value}T00:00:00.000Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
      )
        return "Enter a valid report date.";
    }
    return filters.rangeStart &&
      filters.rangeEnd &&
      filters.rangeStart > filters.rangeEnd
      ? "From must be on or before To."
      : null;
  }

  export function duration(value: number | null): string {
    if (value === null) return "N/A";
    const seconds = Math.round(value / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }

  export function orderedReports(
    reports: TrendData.Report[],
  ): TrendData.Report[] {
    return [...reports].sort((left, right) =>
      (left.timestamp || left.createdAt).localeCompare(
        right.timestamp || right.createdAt,
      ),
    );
  }

  export function statistics(
    series: TrendData.Series,
    reports: TrendData.Report[],
    metric: TrendData.Metric,
  ) {
    if (
      new Set(series.observations.map((observation) => observation.id)).size !==
      series.observations.length
    )
      throw new Error("Duplicate execution identity.");
    const observations = new Map<string, TrendData.Observation[]>();
    for (const observation of series.observations) {
      const group = observations.get(observation.reportUuid) ?? [];
      group.push(observation);
      observations.set(observation.reportUuid, group);
    }
    const ordered = orderedReports(reports);
    const runs = ordered.flatMap((report) => {
      const records = report.issue ? [] : (observations.get(report.uuid) ?? []);
      return (records.length ? records : [undefined])
        .map((observation) => {
          const start = observation?.attempts.find(
            (attempt) => attempt.startTime,
          )?.startTime;
          return {
            report,
            observation,
            id: observation?.id ?? `missing-${report.uuid}`,
            timestamp: start || report.timestamp || report.createdAt,
            timeSource: start ? "attempt" : report.timeSource,
          };
        })
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    });
    const latestReport = ordered.at(-1)?.uuid;
    const latestRun = runs
      .filter((run) => run.report.uuid === latestReport)
      .at(-1);
    const latest = latestRun?.observation?.[metric] ?? null;
    const median = (values: number[]): number => {
      const sorted = [...values].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const values = ordered
      .slice(0, -1)
      .filter((report) => !report.issue)
      .map((report) =>
        (observations.get(report.uuid) ?? [])
          .filter(
            (observation) =>
              observation.passed !== null &&
              ["expected", "flaky"].includes(observation.outcome),
          )
          .map((observation) => observation[metric]!)
          .filter((value) => value !== null),
      )
      .filter((values) => values.length)
      .slice(0, 5)
      .map(median);
    const baseline =
      !series.ambiguous && values.length === 5 ? median(values) : null;
    const change =
      baseline !== null && baseline > 0 && latest !== null
        ? Math.round((latest / baseline - 1) * 100)
        : null;
    const executions = runs.filter(
      ({ observation }) =>
        observation?.total !== null && observation?.total !== undefined,
    ).length;
    const reportCount = new Set(
      runs
        .filter((run) => run.observation?.total != null)
        .map((run) => run.report.uuid),
    ).size;
    runs.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    return {
      runs,
      latest,
      latestId: latestRun?.id,
      baseline,
      change,
      executions,
      reportCount,
    };
  }

  export function outcome(observation?: TrendData.Observation): string {
    if (!observation) return "No title match";
    if (observation.total === null) return "Skipped";
    if (observation.outcome === "flaky") return "Passed on retry";
    if (observation.outcome === "unexpected")
      return observation.passed !== null ? "Unexpected pass" : "Failed";
    return observation.passed !== null ? "Passed" : "Expected failure";
  }

  export function selectedSnapshot(
    data: TrendData.Dataset,
    series: TrendData.Series,
    reports: TrendData.Report[],
    filters: TrendData.Filters,
    metric: TrendData.Metric,
  ): TrendData.Snapshot {
    const ids = new Map(
      reports.map((report, index) => [report.uuid, `report-${index + 1}`]),
    );
    const safePath = (value: string): string =>
      /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value)
        ? (value.split(/[\\/]/).at(-1) ?? "")
        : value;
    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      filters: {
        query: filters.query,
        rangeStart: filters.rangeStart,
        rangeEnd: filters.rangeEnd,
      },
      metric,
      data: {
        schemaVersion: 2,
        generatedAt: data.generatedAt,
        ...(data.selection
          ? {
              selection: {
                excludedReports: data.selection.excludedReports,
                excludedExecutions: data.selection.excludedExecutions,
              },
            }
          : {}),
        reports: reports.map((report) => ({
          uuid: ids.get(report.uuid)!,
          name: report.name,
          metadata: report.metadata,
          createdAt: report.createdAt,
          timestamp: report.timestamp,
          timeSource: report.timeSource,
          scope: report.scope,
          version: "",
          ...(report.issue ? { issue: report.issue } : {}),
        })),
        series: [
          {
            key: "selected-test",
            title: series.title,
            path: series.path.map(safePath),
            file: safePath(series.file),
            project: series.project,
            repeat: series.repeat,
            ambiguous: series.ambiguous,
            observations: series.observations
              .filter((observation) => ids.has(observation.reportUuid))
              .map((observation, index) => ({
                id: `execution-${index + 1}`,
                definition: "selected-test",
                reportUuid: ids.get(observation.reportUuid)!,
                testId: "",
                title: observation.title,
                file: safePath(observation.file),
                line: observation.line,
                column: observation.column,
                project: observation.project,
                repeat: observation.repeat,
                path: observation.path.map(safePath),
                outcome: observation.outcome,
                passed: observation.passed,
                total: observation.total,
                attempts: observation.attempts.map((attempt) => ({
                  index: attempt.index,
                  retry: attempt.retry,
                  startTime: attempt.startTime,
                  duration: attempt.duration,
                  status: attempt.status,
                })),
              })),
          },
        ],
      },
    };
  }

  export function snapshotHtml(
    snapshot: TrendData.Snapshot,
    css: string,
    modelScript: string,
    viewScript: string,
  ): string {
    const json = JSON.stringify(snapshot).replace(
      /[<>&\u2028\u2029]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    const script = (value: string) =>
      value.replace(/<\/script/gi, "<\\/script");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Test Trend Snapshot</title><style>${css}</style></head><body class="trend-snapshot"><main id="trend-snapshot-root"></main><script type="application/json" id="trend-snapshot-data">${json}</script><script>${script(modelScript)}</script><script>${script(viewScript)}</script><script>TrendView.showSnapshot(document.getElementById('trend-snapshot-root'), JSON.parse(document.getElementById('trend-snapshot-data').textContent));</script></body></html>`;
  }
}
