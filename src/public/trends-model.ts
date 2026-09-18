namespace TrendModel {
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
    return [...reports].sort(
      (left, right) =>
        (left.timestamp || left.createdAt).localeCompare(
          right.timestamp || right.createdAt,
        ) || left.uuid.localeCompare(right.uuid),
    );
  }

  export function statistics(
    series: TrendData.Series,
    reports: TrendData.Report[],
    metric: TrendData.Metric,
  ) {
    const observations = new Map(
      series.observations.map((observation) => [
        observation.reportUuid,
        observation,
      ]),
    );
    const runs = orderedReports(reports).map((report) => ({
      report,
      observation: report.issue ? undefined : observations.get(report.uuid),
    }));
    const latest = runs.at(-1)?.observation?.[metric] ?? null;
    const prior = runs
      .slice(0, -1)
      .filter(
        ({ observation }) =>
          observation &&
          observation.passed !== null &&
          ["expected", "flaky"].includes(observation.outcome),
      )
      .slice(0, 5);
    const values = prior
      .map(({ observation }) => observation![metric]!)
      .sort((left, right) => left - right);
    const baseline =
      !series.ambiguous && values.length === 5 ? values[2] : null;
    const change =
      baseline !== null && baseline > 0 && latest !== null
        ? Math.round((latest / baseline - 1) * 100)
        : null;
    const executions = runs.filter(
      ({ observation }) =>
        observation?.total !== null && observation?.total !== undefined,
    ).length;
    return { runs, latest, baseline, change, executions };
  }

  export function outcome(observation?: TrendData.Observation): string {
    if (!observation) return "Not run";
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
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      filters: {
        query: filters.query,
        rangeStart: filters.rangeStart,
        rangeEnd: filters.rangeEnd,
      },
      metric,
      data: {
        schemaVersion: 1,
        generatedAt: data.generatedAt,
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
              .map((observation) => ({
                reportUuid: ids.get(observation.reportUuid)!,
                testId: "",
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
