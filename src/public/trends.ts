namespace TrendView {
  interface Options {
    catalog: (signal: AbortSignal) => Promise<TrendData.Catalog>;
    onClose: () => void;
  }
  const escape = (value: unknown): string =>
    String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character]!,
    );
  const icon = (paths: string) =>
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const closeIcon = icon('<path d="m18 6-12 12M6 6l12 12"/>');
  const downloadIcon = icon(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  );
  const externalIcon = icon(
    '<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>',
  );
  const calendarDate = (value: string) =>
    value
      ? new Date(value).toLocaleString(undefined, {
          timeZone: "UTC",
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }) + " UTC"
      : "Unavailable";
  const changeText = (value: number | null) =>
    value === null ? "N/A" : `${value > 0 ? "+" : ""}${value}%`;
  const changeClass = (value: number | null) =>
    value === null || Math.abs(value) < 5
      ? "muted"
      : value > 0
        ? "increase"
        : "decrease";
  const jsonRequest = async <Result>(
    url: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Result> => {
    const response = await fetch(url, {
      signal,
      ...(body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Request failed.");
    return result as Result;
  };

  class Viewer {
    private data: TrendData.Dataset | null = null;
    private selected = new Set<string>();
    private seriesKey = "";
    private reportUuid = "";
    private metric: TrendData.Metric = "passed";
    private filters: TrendData.Filters = {
      query: "",
      rangeStart: "",
      rangeEnd: "",
    };
    private edited = { rangeStart: false, rangeEnd: false };
    private abort = new AbortController();
    private events = new AbortController();
    private sequence = 0;
    private page = 0;
    private points: { horizontal: number; report: TrendData.Report }[] = [];
    private observer: ResizeObserver;
    private destroyed = false;
    private downloading = false;

    constructor(
      private root: HTMLElement,
      private options?: Options,
    ) {
      root.classList.add("trends");
      root.innerHTML = `
        <header class="trend-heading"><div><h1 data-role="heading">Test Trends</h1><p class="muted" data-role="subtitle">Functional test duration</p></div><button type="button" class="trend-icon" data-role="close" aria-label="Close Trends" title="Close Trends">${closeIcon}</button></header>
        <form class="trend-filters" data-role="filters">
          <label class="trend-metadata">Metadata<input data-role="metadata" placeholder="Any metadata" maxlength="256" autocomplete="off"></label>
          <label>From (UTC)<input data-role="from" type="date"></label><label>To (UTC)<input data-role="to" type="date"></label>
          <button type="submit" class="trend-primary" data-role="apply">Apply filters</button>
        </form>
        <p class="trend-message" data-role="message" role="status" aria-live="polite"></p>
        <details class="trend-reports" data-role="reports" hidden><summary data-role="report-summary">Reports</summary><div class="trend-scroll"><table><thead><tr><th>Include</th><th>Report date (UTC)</th><th>Report</th><th>Metadata</th><th>Location</th></tr></thead><tbody data-role="report-rows"></tbody></table></div></details>
        <div class="trend-workspace" data-role="workspace" hidden>
          <aside class="trend-list" data-role="list" aria-label="Test cases">
            <div class="trend-section-head"><h2>Test cases</h2><span class="muted" data-role="test-count"></span></div>
            <input data-role="search" aria-label="Find a test" placeholder="Find a test..." type="search">
            <div class="trend-list-controls"><select data-role="project" aria-label="Filter project"><option value="">All projects</option></select><select data-role="sort" aria-label="Sort tests"><option value="change">Largest increase</option><option value="latest">Longest duration</option><option value="name">Test name</option></select></div>
            <div class="trend-columns"><span>TEST / TREND</span><span>LATEST / CHANGE</span></div><div data-role="test-rows"></div>
            <div class="trend-pagination"><button type="button" data-role="previous" class="trend-icon" title="Previous tests" aria-label="Previous tests">${icon('<path d="m15 18-6-6 6-6"/>')}</button><span class="muted" data-role="page"></span><button type="button" data-role="next" class="trend-icon" title="Next tests" aria-label="Next tests">${icon('<path d="m9 18 6-6-6-6"/>')}</button></div>
          </aside>
          <section class="trend-detail" data-role="detail" aria-label="Selected test trend" hidden>
            <div class="trend-section-head"><h2 data-role="title"></h2><button type="button" data-role="export" class="trend-icon" title="Download selected test as HTML (includes report labels and metadata)" aria-label="Export selected test as HTML">${downloadIcon}</button></div>
            <p class="trend-context muted" data-role="context"></p><p class="trend-status muted" data-role="series-status"></p>
            <div class="trend-metric-row"><div class="trend-segments" role="group" aria-label="Duration metric"><button type="button" data-metric="passed" aria-pressed="true">Passed attempt</button><button type="button" data-metric="total" aria-pressed="false">Total incl. retries</button></div><span class="muted">Baseline: first 5 earlier passing runs</span></div>
            <canvas data-role="chart" tabindex="0" aria-label="Duration by execution time. Arrow keys select a report; details are in the run history."></canvas>
            <div class="trend-legend"><span>Passed</span><span class="flaky">Passed on retry</span><span class="failed">Failed / unexpected</span><span class="baseline">Baseline median</span></div>
            <div class="trend-stats"><div><span>LATEST VALUE</span><strong data-role="latest"></strong></div><div><span>BASELINE MEDIAN</span><strong data-role="baseline"></strong></div><div><span>VS BASELINE</span><strong data-role="change"></strong></div></div>
            <div class="trend-selected" data-role="selected-run" aria-live="polite"></div>
            <div class="trend-section-head"><h3>Run history</h3><span class="muted" data-role="history-count"></span></div>
            <div class="trend-history trend-scroll"><table><thead><tr><th>Execution (UTC)</th><th>Outcome</th><th>Passed</th><th>Total</th><th data-role="link-heading">Report</th></tr></thead><tbody data-role="history"></tbody></table></div>
          </section>
        </div>`;
      const signal = this.events.signal;
      this.element("close").hidden = !options;
      this.element("filters").hidden = !options;
      this.element("export").hidden = !options;
      this.element("list").hidden = !options;
      this.element("close").addEventListener("click", () => this.close(), {
        signal,
      });
      this.element("filters").addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          void this.apply();
        },
        { signal },
      );
      for (const [role, field] of [
        ["from", "rangeStart"],
        ["to", "rangeEnd"],
      ] as const)
        this.element(role).addEventListener(
          "input",
          () => {
            this.edited[field] = true;
          },
          { signal },
        );
      for (const role of ["search", "project", "sort"])
        this.element(role).addEventListener(
          role === "search" ? "input" : "change",
          () => {
            this.page = 0;
            this.renderList();
          },
          { signal },
        );
      for (const [role, delta] of [
        ["previous", -1],
        ["next", 1],
      ] as const)
        this.element(role).addEventListener(
          "click",
          () => {
            this.page += delta;
            this.renderList();
          },
          { signal },
        );
      this.element("test-rows").addEventListener(
        "click",
        (event) => {
          const row = (event.target as HTMLElement).closest<HTMLButtonElement>(
            "[data-series]",
          );
          if (!row) return;
          this.seriesKey = row.dataset.series!;
          this.element("test-rows")
            .querySelectorAll<HTMLButtonElement>("[data-series]")
            .forEach((button) =>
              button.setAttribute("aria-pressed", String(button === row)),
            );
          this.renderDetail();
        },
        { signal },
      );
      this.element("report-rows").addEventListener(
        "change",
        (event) => {
          const checkbox = event.target as HTMLInputElement;
          if (!checkbox.dataset.report) return;
          if (checkbox.checked) this.selected.add(checkbox.dataset.report);
          else this.selected.delete(checkbox.dataset.report);
          this.page = 0;
          this.renderReports();
          this.renderList();
        },
        { signal },
      );
      root
        .querySelectorAll<HTMLButtonElement>("[data-metric]")
        .forEach((button) =>
          button.addEventListener(
            "click",
            () => {
              this.metric = button.dataset.metric as TrendData.Metric;
              this.page = 0;
              this.renderList();
            },
            { signal },
          ),
        );
      this.element("history").addEventListener(
        "click",
        (event) => {
          const button = (
            event.target as HTMLElement
          ).closest<HTMLButtonElement>("[data-point]");
          if (button) {
            this.reportUuid = button.dataset.point!;
            this.renderDetail();
          }
        },
        { signal },
      );
      this.element("chart").addEventListener(
        "click",
        (event) => {
          const coordinate =
            event.clientX - this.element("chart").getBoundingClientRect().left;
          const closest = [...this.points].sort(
            (left, right) =>
              Math.abs(left.horizontal - coordinate) -
              Math.abs(right.horizontal - coordinate),
          )[0];
          if (closest) {
            this.reportUuid = closest.report.uuid;
            this.renderDetail();
          }
        },
        { signal },
      );
      this.element("chart").addEventListener(
        "keydown",
        (event) => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const index = this.points.findIndex(
            (point) => point.report.uuid === this.reportUuid,
          );
          const next =
            this.points[
              Math.max(
                0,
                Math.min(
                  this.points.length - 1,
                  index + (event.key === "ArrowLeft" ? -1 : 1),
                ),
              )
            ];
          if (next) {
            this.reportUuid = next.report.uuid;
            this.renderDetail();
          }
        },
        { signal },
      );
      this.element("export").addEventListener(
        "click",
        () => {
          void this.export();
        },
        { signal },
      );
      this.observer = new ResizeObserver(() => {
        if (this.data) {
          this.drawChart();
          this.drawSparklines();
        }
      });
      this.observer.observe(this.element("workspace"));
    }

    private element(role: string): HTMLElement {
      return this.root.querySelector<HTMLElement>(`[data-role="${role}"]`)!;
    }
    private input(role: string): HTMLInputElement {
      return this.element(role) as HTMLInputElement;
    }
    private reports(): TrendData.Report[] {
      return (
        this.data?.reports.filter((report) => this.selected.has(report.uuid)) ??
        []
      );
    }
    private series(): TrendData.Series | undefined {
      return this.data?.series.find((series) => series.key === this.seriesKey);
    }
    private message(text: string, error = false) {
      const element = this.element("message");
      element.textContent = text;
      element.classList.toggle("trend-error", error);
    }
    private setBounds(catalog: TrendData.Catalog) {
      const bounds = TrendModel.dateBounds([
        ...catalog.current,
        ...catalog.archive,
      ]);
      for (const [role, field] of [
        ["from", "rangeStart"],
        ["to", "rangeEnd"],
      ] as const) {
        if (!this.edited[field]) this.input(role).value = bounds[field];
        this.input(role).disabled = !bounds.rangeStart;
      }
      return bounds;
    }

    async initialize() {
      this.message("Loading available reports...");
      this.input("apply").disabled = true;
      const sequence = this.sequence;
      try {
        const catalog = await this.options!.catalog(this.abort.signal);
        if (this.destroyed || sequence !== this.sequence) return;
        const bounds = this.setBounds(catalog);
        this.message(bounds.rangeStart ? "" : "No reports available.");
        this.input("apply").disabled = !bounds.rangeStart;
        this.input("metadata").focus();
      } catch (error) {
        if (!this.destroyed) this.message((error as Error).message, true);
      }
    }

    private async apply() {
      if (!this.options) return;
      const filters = {
        query: this.input("metadata").value.trim(),
        rangeStart: this.input("from").value,
        rangeEnd: this.input("to").value,
      };
      const invalid = TrendModel.validateFilters(filters);
      if (invalid) {
        this.message(invalid, true);
        return;
      }
      this.abort.abort();
      this.abort = new AbortController();
      const sequence = ++this.sequence;
      this.input("apply").disabled = true;
      this.element("workspace").hidden = true;
      this.element("reports").hidden = true;
      this.message("Reading report timings...");
      try {
        const catalog = await this.options.catalog(this.abort.signal);
        if (sequence !== this.sequence || this.destroyed) return;
        const bounds = this.setBounds(catalog);
        if (!this.edited.rangeStart) filters.rangeStart = bounds.rangeStart;
        if (!this.edited.rangeEnd) filters.rangeEnd = bounds.rangeEnd;
        const invalidBounds = TrendModel.validateFilters(filters);
        if (invalidBounds) throw new Error(invalidBounds);
        const query = new URLSearchParams(filters);
        const matches = await jsonRequest<TrendData.Catalog>(
          `/api/report-search?${query}`,
          this.abort.signal,
        );
        const uuids = [...matches.current, ...matches.archive].map(
          (report) => report.uuid,
        );
        const data = await jsonRequest<TrendData.Dataset>(
          "/api/trends",
          this.abort.signal,
          { reportUuids: uuids },
        );
        if (sequence !== this.sequence || this.destroyed) return;
        this.filters = filters;
        this.show(data);
      } catch (error) {
        if (
          sequence === this.sequence &&
          !this.destroyed &&
          (error as Error).name !== "AbortError"
        )
          this.message((error as Error).message, true);
      } finally {
        if (sequence === this.sequence && !this.destroyed)
          this.input("apply").disabled = false;
      }
    }

    show(data: TrendData.Dataset, snapshot?: TrendData.Snapshot) {
      this.data = data;
      this.selected = new Set(data.reports.map((report) => report.uuid));
      this.page = 0;
      this.seriesKey = "";
      this.reportUuid = "";
      if (snapshot) {
        this.metric = snapshot.metric;
        this.filters = snapshot.filters;
        this.element("heading").textContent = "Test Trend Snapshot";
        this.element("subtitle").textContent =
          `Captured ${calendarDate(snapshot.exportedAt)}${snapshot.filters.query ? ` / ${snapshot.filters.query}` : ""} / ${snapshot.filters.rangeStart || "Any date"} to ${snapshot.filters.rangeEnd || "Any date"}`;
        this.element("workspace").classList.add("trend-offline");
      }
      const issues = data.reports.filter((report) => report.issue);
      this.message(
        issues.length
          ? `${issues.length} report(s) unavailable. Results are incomplete; see the report list.`
          : data.reports.length
            ? data.series.length
              ? ""
              : "No test timing data in these reports."
            : "No reports match these filters.",
        issues.length > 0,
      );
      if (snapshot && issues.length)
        this.message(
          `${issues.length} report(s) were unavailable when this snapshot was captured.`,
          true,
        );
      const projects = [
        ...new Set(data.series.map((series) => series.project)),
      ].sort();
      this.element("project").innerHTML =
        '<option value="">All projects</option>' +
        projects
          .map(
            (project) =>
              `<option value="${escape(project)}">${escape(project)}</option>`,
          )
          .join("");
      this.input("search").value = "";
      this.element("workspace").hidden = !data.series.length;
      this.element("reports").hidden = !this.options || !data.reports.length;
      this.renderReports();
      this.renderList();
    }

    private renderReports() {
      if (!this.data) return;
      this.element("report-summary").textContent =
        `${this.selected.size} of ${this.data.reports.length} reports selected / ${this.reports().filter((report) => report.scope === "archive").length} archived`;
      this.element("report-rows").innerHTML = this.data.reports
        .map(
          (report) =>
            `<tr><td><input type="checkbox" data-report="${escape(report.uuid)}" aria-label="Include ${escape(report.name)}" ${this.selected.has(report.uuid) ? "checked" : ""}></td><td>${escape(calendarDate(report.createdAt))}</td><td>${escape(report.name)}${report.issue ? `<p class="trend-error">${escape(report.issue)}</p>` : ""}</td><td>${escape(report.metadata)}</td><td>${escape(report.scope)}</td></tr>`,
        )
        .join("");
    }

    private renderList() {
      if (!this.data) return;
      const query = this.input("search").value.toLowerCase();
      const project = this.input("project").value;
      const reports = this.reports();
      const rows = this.data.series
        .filter(
          (series) =>
            (!project || series.project === project) &&
            `${series.title} ${series.path.join(" ")} ${series.file}`
              .toLowerCase()
              .includes(query) &&
            series.observations.some((observation) =>
              this.selected.has(observation.reportUuid),
            ),
        )
        .map((series) => ({
          series,
          stats: TrendModel.statistics(series, reports, this.metric),
        }));
      const sort = this.input("sort").value;
      rows.sort((left, right) => {
        if (sort !== "name") {
          const field = sort === "latest" ? "latest" : "change";
          const leftValue = left.stats[field] ?? -Infinity;
          const rightValue = right.stats[field] ?? -Infinity;
          if (leftValue !== rightValue) return rightValue - leftValue;
          if (field === "change" && left.stats.latest !== right.stats.latest)
            return (right.stats.latest ?? -1) - (left.stats.latest ?? -1);
        }
        return left.series.title.localeCompare(right.series.title);
      });
      if (!rows.some(({ series }) => series.key === this.seriesKey))
        this.seriesKey = rows[0]?.series.key ?? "";
      const pages = Math.max(1, Math.ceil(rows.length / 40));
      this.page = Math.max(0, Math.min(this.page, pages - 1));
      this.element("test-count").textContent = `${rows.length} tests`;
      this.element("page").textContent = rows.length
        ? `${this.page + 1} / ${pages}`
        : "0 tests";
      this.input("previous").disabled = this.page === 0;
      this.input("next").disabled = this.page >= pages - 1;
      this.element("test-rows").innerHTML =
        rows
          .slice(this.page * 40, (this.page + 1) * 40)
          .map(
            ({ series, stats }) =>
              `<button type="button" class="trend-test" data-series="${escape(series.key)}" aria-pressed="${series.key === this.seriesKey}"><span class="trend-test-title">${escape(series.title)}</span><span class="trend-test-context">${escape(series.project)}${series.repeat ? ` / repeat ${series.repeat}` : ""} / ${escape(series.file)}</span><span class="trend-test-values"><canvas data-spark="${escape(series.key)}" aria-hidden="true"></canvas><span>${TrendModel.duration(stats.latest)} <span class="${changeClass(stats.change)}">${changeText(stats.change)}</span></span></span></button>`,
          )
          .join("") || '<p class="muted">No matching tests.</p>';
      this.drawSparklines();
      this.renderDetail();
    }

    private link(
      series: TrendData.Series,
      report: TrendData.Report,
      observation: TrendData.Observation | undefined,
      label: string,
      index = 0,
    ): string {
      if (!this.options || !observation?.attempts[index] || report.issue)
        return "";
      const query = new URLSearchParams({
        testId: observation.testId,
        run: String(index),
        version: report.version,
      });
      return `<a href="/api/trends/reports/${encodeURIComponent(report.uuid)}/test?${escape(query)}" target="_blank" rel="noopener" class="trend-link" aria-label="${escape(label)} for ${escape(series.title)}" title="Open this test attempt in a new tab">${escape(label)}${externalIcon}</a>`;
    }

    private renderDetail() {
      const series = this.series();
      this.element("detail").hidden = !series;
      if (!series) return;
      const stats = TrendModel.statistics(series, this.reports(), this.metric);
      if (!stats.runs.some(({ report }) => report.uuid === this.reportUuid))
        this.reportUuid = stats.runs.at(-1)?.report.uuid ?? "";
      this.element("title").textContent = series.title;
      this.element("context").textContent =
        `${series.project} / ${series.path.join(" > ")} / ${series.file}${series.repeat ? ` / repeat ${series.repeat}` : ""}`;
      this.element("series-status").textContent = series.ambiguous
        ? "Ambiguous identity; records are kept separate."
        : stats.executions === 1
          ? "1 run; trend not available yet"
          : stats.executions === 0
            ? "No executions in the selected reports."
            : stats.baseline === null
              ? `${stats.executions} runs / insufficient baseline`
              : `${stats.executions} runs`;
      this.root
        .querySelectorAll<HTMLButtonElement>("[data-metric]")
        .forEach((button) =>
          button.setAttribute(
            "aria-pressed",
            String(button.dataset.metric === this.metric),
          ),
        );
      this.element("latest").textContent = TrendModel.duration(stats.latest);
      this.element("baseline").textContent = TrendModel.duration(
        stats.baseline,
      );
      this.element("change").textContent = changeText(stats.change);
      this.element("change").className = changeClass(stats.change);
      this.element("history-count").textContent =
        `${stats.runs.filter(({ observation }) => observation?.passed !== null && observation?.passed !== undefined).length} passing / ${stats.runs.length} reports`;
      const selected = stats.runs.find(
        ({ report }) => report.uuid === this.reportUuid,
      );
      if (selected) {
        const { report, observation } = selected;
        const successful = observation?.attempts.find(
          (attempt) => attempt.status === "passed",
        );
        const index = this.metric === "passed" ? (successful?.index ?? 0) : 0;
        this.element("selected-run").innerHTML =
          `<div class="trend-section-head"><strong>${escape(calendarDate(report.timestamp))}</strong>${this.link(series, report, observation, "Open test", index)}</div><p>${escape(report.issue ? "Report unavailable" : TrendModel.outcome(observation))}${observation?.total !== null && observation?.total !== undefined ? ` / Total ${TrendModel.duration(observation.total)}` : ""}</p><p class="muted">${escape(report.name)} / ${escape(report.metadata)} / ${escape(report.scope)}${report.timeSource !== "report" ? ` / ${report.timeSource} timestamp fallback` : ""}</p>${observation?.attempts.map((attempt) => `<div class="trend-attempt"><span>${attempt.retry ? `Retry ${attempt.retry}` : "Run"}: ${TrendModel.duration(attempt.duration)} / ${escape(attempt.status)}</span>${this.link(series, report, observation, "Open attempt", attempt.index)}</div>`).join("") ?? ""}`;
      } else this.element("selected-run").textContent = "No reports selected.";
      this.element("history").innerHTML = [...stats.runs]
        .reverse()
        .map(
          ({ report, observation }) =>
            `<tr class="${report.uuid === this.reportUuid ? "selected" : ""}"><td><button type="button" class="trend-point" data-point="${escape(report.uuid)}" aria-pressed="${report.uuid === this.reportUuid}">${escape(calendarDate(report.timestamp))}</button></td><td>${escape(report.issue ? "Unavailable" : TrendModel.outcome(observation))}</td><td>${TrendModel.duration(observation?.passed ?? null)}</td><td>${TrendModel.duration(observation?.total ?? null)}</td><td>${this.options ? this.link(series, report, observation, report.scope) : escape(report.name)}</td></tr>`,
        )
        .join("");
      this.drawChart();
    }

    private context(canvas: HTMLCanvasElement) {
      const bounds = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      const context = canvas.getContext("2d")!;
      context.scale(ratio, ratio);
      return { context, width: bounds.width, height: bounds.height };
    }

    private drawSparklines() {
      if (!this.data) return;
      const seriesMap = new Map(
        this.data.series.map((series) => [series.key, series]),
      );
      this.element("test-rows")
        .querySelectorAll<HTMLCanvasElement>("canvas[data-spark]")
        .forEach((canvas) => {
          const series = seriesMap.get(canvas.dataset.spark!);
          if (!series) return;
          const { context, width, height } = this.context(canvas);
          const values = TrendModel.statistics(
            series,
            this.reports(),
            this.metric,
          ).runs.map(({ observation }) => observation?.[this.metric] ?? null);
          const valid = values.filter(
            (value): value is number => value !== null,
          );
          const maximum = Math.max(1, ...valid);
          const minimum = Math.min(maximum, ...valid);
          context.strokeStyle = "#58a6ff";
          context.fillStyle = "#58a6ff";
          context.lineWidth = 1.5;
          context.beginPath();
          let connected = false;
          values.forEach((value, index) => {
            if (value === null) {
              connected = false;
              return;
            }
            const horizontal =
              3 + (index / Math.max(1, values.length - 1)) * (width - 6);
            const vertical =
              height -
              3 -
              ((value - minimum) / Math.max(1000, maximum - minimum)) *
                (height - 6);
            if (connected) context.lineTo(horizontal, vertical);
            else context.moveTo(horizontal, vertical);
            connected = true;
            context.fillRect(horizontal - 1, vertical - 1, 2, 2);
          });
          context.stroke();
        });
    }

    private drawChart() {
      const series = this.series();
      if (!series || this.element("detail").hidden) return;
      const { context, width, height } = this.context(
        this.element("chart") as HTMLCanvasElement,
      );
      const stats = TrendModel.statistics(series, this.reports(), this.metric);
      const runs = stats.runs;
      this.points = [];
      const displayed = runs.map(
        ({ observation }) =>
          observation?.[this.metric] ??
          observation?.attempts.find((attempt) => attempt.status !== "skipped")
            ?.duration ??
          null,
      );
      const ceiling =
        Math.ceil(
          Math.max(
            60000,
            ...displayed.filter((value): value is number => value !== null),
            stats.baseline ?? 0,
          ) / 60000,
        ) * 60000;
      const left = 48;
      const right = width - 16;
      const top = 18;
      const bottom = height - 34;
      const vertical = (value: number) =>
        bottom - (value / ceiling) * (bottom - top);
      const times = runs.map(({ report }) =>
        Date.parse(report.timestamp || report.createdAt),
      );
      const validTimes = times.filter(Number.isFinite);
      const first = Math.min(...validTimes);
      const last = Math.max(...validTimes);
      const horizontal = (index: number) =>
        first === last
          ? (left + right) / 2
          : left +
            (Number.isFinite(times[index])
              ? (times[index] - first) / (last - first)
              : index / Math.max(1, runs.length - 1)) *
              (right - left);
      context.font = "11px sans-serif";
      context.textBaseline = "middle";
      context.lineWidth = 1;
      for (let tick = 0; tick <= 4; tick++) {
        const value = (ceiling * tick) / 4;
        const position = vertical(value);
        context.strokeStyle = "#30363d";
        context.beginPath();
        context.moveTo(left, position);
        context.lineTo(right, position);
        context.stroke();
        context.fillStyle = "#9da7b3";
        context.textAlign = "right";
        context.fillText(
          `${Number((value / 60000).toFixed(1))}m`,
          left - 8,
          position,
        );
      }
      if (stats.baseline !== null) {
        context.strokeStyle = "#9da7b3";
        context.setLineDash([5, 5]);
        context.beginPath();
        context.moveTo(left, vertical(stats.baseline));
        context.lineTo(right, vertical(stats.baseline));
        context.stroke();
        context.setLineDash([]);
      }
      context.strokeStyle = "#58a6ff";
      context.lineWidth = 2;
      context.beginPath();
      let connected = false;
      runs.forEach(({ observation }, index) => {
        const value = observation?.[this.metric];
        if (value === null || value === undefined) {
          connected = false;
          return;
        }
        if (connected) context.lineTo(horizontal(index), vertical(value));
        else context.moveTo(horizontal(index), vertical(value));
        connected = true;
      });
      context.stroke();
      runs.forEach(({ report, observation }, index) => {
        const position = horizontal(index);
        const value = displayed[index];
        this.points.push({ horizontal: position, report });
        const failed =
          observation &&
          (observation.passed === null || observation.outcome === "unexpected");
        context.strokeStyle = failed
          ? "#ff8585"
          : observation?.outcome === "flaky"
            ? "#eac268"
            : "#58a6ff";
        context.fillStyle = context.strokeStyle;
        if (value !== null) {
          const point = vertical(value);
          if (failed) {
            context.beginPath();
            context.moveTo(position - 4, point - 4);
            context.lineTo(position + 4, point + 4);
            context.moveTo(position + 4, point - 4);
            context.lineTo(position - 4, point + 4);
            context.stroke();
          } else {
            context.beginPath();
            context.arc(position, point, 4, 0, Math.PI * 2);
            context.fill();
          }
          if (report.uuid === this.reportUuid) {
            context.beginPath();
            context.arc(position, point, 8, 0, Math.PI * 2);
            context.stroke();
          }
        }
        const interval = Math.max(
          1,
          Math.ceil(runs.length / (width < 450 ? 3 : 6)),
        );
        if (index % interval === 0 || index === runs.length - 1) {
          context.fillStyle = "#9da7b3";
          context.textAlign =
            index === 0
              ? "left"
              : index === runs.length - 1
                ? "right"
                : "center";
          const time = report.timestamp || report.createdAt;
          context.fillText(
            time
              ? new Date(time).toLocaleDateString(undefined, {
                  timeZone: "UTC",
                  month: "short",
                  day: "numeric",
                })
              : "Missing",
            position,
            height - 11,
          );
        }
      });
    }

    private async export() {
      const series = this.series();
      if (!series || !this.data || this.downloading || !this.options) return;
      this.downloading = true;
      this.input("export").disabled = true;
      const snapshot = TrendModel.selectedSnapshot(
        this.data,
        series,
        this.reports(),
        this.filters,
        this.metric,
      );
      try {
        const assets = await Promise.all(
          ["trends.css", "trends-model.js", "trends.js"].map(async (file) => {
            const response = await fetch(file, { signal: this.events.signal });
            if (!response.ok)
              throw new Error(
                "Export assets are unavailable. Refresh the dashboard.",
              );
            return response.text();
          }),
        );
        if (this.destroyed) return;
        const html = TrendModel.snapshotHtml(
          snapshot,
          assets[0],
          assets[1],
          assets[2],
        );
        const objectUrl = URL.createObjectURL(
          new Blob([html], { type: "text/html;charset=utf-8" }),
        );
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        const name =
          series.title.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80) || "test";
        anchor.download = `trends-${name}-${new Date().toISOString().slice(0, 10)}.html`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      } catch (error) {
        if (!this.destroyed) this.message((error as Error).message, true);
      } finally {
        this.downloading = false;
        if (!this.destroyed) this.input("export").disabled = false;
      }
    }

    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.sequence++;
      this.abort.abort();
      this.events.abort();
      this.observer.disconnect();
      this.data = null;
      this.selected.clear();
      this.points = [];
      const dialog = this.root.closest("dialog");
      dialog?.close();
      dialog?.remove();
      this.options?.onClose();
    }
  }

  export function open(options: Options): void {
    const dialog = document.createElement("dialog");
    dialog.className = "trend-dialog";
    dialog.setAttribute("aria-label", "Test Trends");
    const content = document.createElement("div");
    dialog.append(content);
    document.body.append(dialog);
    const viewer = new Viewer(content, options);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      viewer.close();
    });
    dialog.showModal();
    void viewer.initialize();
  }

  export function showSnapshot(
    root: HTMLElement,
    snapshot: TrendData.Snapshot,
  ): void {
    if (
      snapshot.schemaVersion !== 1 ||
      snapshot.data.schemaVersion !== 1 ||
      snapshot.data.series.length !== 1
    ) {
      root.textContent = "Unsupported trend snapshot.";
      return;
    }
    new Viewer(root).show(snapshot.data, snapshot);
  }
}
