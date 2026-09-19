namespace TrendView {
  interface Options {
    catalog: (signal: AbortSignal) => Promise<TrendData.Catalog>;
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
  const backIcon = icon('<path d="m12 19-7-7 7-7M5 12h14"/>');
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
          second: "2-digit",
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
  const countLabel = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;
  const sourceLabel = (record: TrendData.Observation) =>
    `${record.project || "(unnamed project)"} / ${record.path.join(" > ")} / ${record.file}${record.line === null ? "" : `:${record.line}:${record.column ?? "?"}`}`;
  const repeatLabel = (record: TrendData.Observation) =>
    record.repeat === null
      ? "First / unlabelled execution"
      : `Repeat index ${record.repeat}`;
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
    private preview: TrendData.Preview | null = null;
    private selected = new Set<string>();
    private excluded = new Set<string>();
    private projects: string[] = [];
    private executionId = "";
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
    private loading = false;
    private points: { horizontal: number; vertical: number; id: string }[] = [];
    private observer: ResizeObserver;
    private destroyed = false;
    private downloading = false;

    constructor(
      private root: HTMLElement,
      private options?: Options,
    ) {
      root.classList.add("trends");
      root.innerHTML = `
        <header class="trend-heading"><div><h1 data-role="heading">Test Trends</h1><p class="muted" data-role="subtitle">Playwright Reports</p></div>${options ? `<a class="trend-dashboard" href="./" data-role="dashboard">${backIcon}Reports</a>` : ""}</header>
        <details class="trend-zone" data-role="search-zone" open>
        <summary class="trend-zone-heading"><span class="trend-step" aria-hidden="true">1</span><h2>Search</h2><span class="trend-zone-summary muted" data-role="search-summary"></span></summary>
        <form class="trend-filters" data-role="filters">
          <label>Metadata<input data-role="metadata" placeholder="Any metadata" maxlength="256" autocomplete="off"></label>
          <label>From (UTC)<input data-role="from" type="date"></label><label>To (UTC)<input data-role="to" type="date"></label>
          <label class="trend-title-query">Test title contains<input data-role="test-query" type="search" required maxlength="256" placeholder="Title or stable fragment" autocomplete="off"></label>
          <button type="submit" class="trend-primary" data-role="apply">Search matches</button>
        </form>
        </details>
        <p class="trend-message" data-role="message" role="status" aria-live="polite"></p>
        <details class="trend-zone trend-reports" data-role="reports" aria-label="Match review" hidden open>
          <summary class="trend-zone-heading"><span class="trend-step" aria-hidden="true">2</span><h2>Review matches</h2><span class="trend-zone-summary" data-role="report-summary" role="status" aria-live="polite"></span></summary>
          <div class="trend-review-controls">
            <label class="trend-project-field" data-role="project-field"><span>Playwright project <span class="trend-required" data-role="project-required">Required</span></span><select data-role="project" aria-label="Playwright project" aria-describedby="trend-generation-status" required></select></label>
            <div class="trend-generate-action"><span id="trend-generation-status" data-role="generation-status" role="status" aria-live="polite"></span><button type="button" class="trend-primary" data-role="generate" aria-describedby="trend-generation-status" disabled>Generate trend</button></div>
          </div>
          <div class="trend-review-scroll" data-role="review-table"><table><thead><tr><th>Include</th><th>Report / date (UTC)</th><th>Matches</th></tr></thead><tbody data-role="report-rows"></tbody></table></div>
        </details>
        <div class="trend-workspace" data-role="workspace" hidden>
          <section class="trend-detail" data-role="detail" aria-label="Selected test trend">
            <div class="trend-section-head"><h2 data-role="title" tabindex="-1"></h2><button type="button" data-role="export" class="trend-icon" title="Download selected test as HTML (includes report labels and metadata)" aria-label="Export selected test as HTML">${downloadIcon}</button></div>
            <p class="trend-context muted" data-role="context"></p><p class="trend-status muted" data-role="series-status"></p>
            <div class="trend-metric-row"><div class="trend-segments" role="group" aria-label="Duration metric"><button type="button" data-metric="passed" aria-pressed="true">Passed attempt</button><button type="button" data-metric="total" aria-pressed="false">Total incl. retries</button></div><span class="muted" title="Median of passing repetition medians from the first 5 earlier eligible reports">Baseline: 5 earlier reports, equally weighted</span></div>
            <canvas data-role="chart" tabindex="0" aria-label="Duration by execution time. Arrow keys select an execution; details are in the run history."></canvas>
            <div class="trend-legend"><span>Passed</span><span class="flaky">Passed on retry</span><span class="failed">Failed / unexpected</span><span class="baseline">Baseline median</span></div>
            <div class="trend-stats"><div><span>LATEST VALUE</span><strong data-role="latest"></strong></div><div><span>BASELINE MEDIAN</span><strong data-role="baseline"></strong></div><div><span>VS BASELINE</span><strong data-role="change"></strong></div></div>
            <div class="trend-selected" data-role="selected-run" aria-live="polite"></div>
            <div class="trend-section-head"><h3>Run history</h3><span class="muted" data-role="history-count"></span></div>
            <div class="trend-history trend-scroll"><table><thead><tr><th>Execution (UTC)</th><th>Outcome</th><th>Passed</th><th>Total</th><th>Report</th></tr></thead><tbody data-role="history"></tbody></table></div>
          </section>
        </div>`;
      const signal = this.events.signal;
      for (const role of ["search-zone", "export"])
        this.element(role).hidden = !options;
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
      this.element("filters").addEventListener(
        "input",
        () => {
          if (this.preview || this.data || this.loading) {
            this.invalidate(true);
            this.message("Search changed. Search matches again.");
          }
        },
        { signal },
      );
      this.element("project").addEventListener(
        "change",
        () => {
          this.excluded.clear();
          this.invalidate();
          this.renderReview();
        },
        { signal },
      );
      this.element("generate").addEventListener(
        "click",
        () => {
          if (!this.preview) return;
          try {
            this.show(
              TrendModel.generate(
                this.preview,
                this.project(),
                this.selected,
                this.excluded,
              ),
            );
            (this.element("search-zone") as HTMLDetailsElement).open = false;
            (this.element("reports") as HTMLDetailsElement).open = false;
            this.element("title").focus({ preventScroll: true });
            this.root.scrollIntoView({ block: "start" });
            if (
              this.element("chart").getBoundingClientRect().bottom >
              window.innerHeight
            )
              this.element("workspace").scrollIntoView({ block: "start" });
          } catch (error) {
            this.message((error as Error).message, true);
          }
        },
        { signal },
      );
      this.element("report-rows").addEventListener(
        "change",
        (event) => {
          const checkbox = event.target as HTMLInputElement;
          if (!this.preview || !checkbox.matches("input[type=checkbox]"))
            return;
          if (checkbox.dataset.report) {
            if (checkbox.checked) this.selected.add(checkbox.dataset.report);
            else this.selected.delete(checkbox.dataset.report);
          } else {
            const records = this.preview.candidates.filter((candidate) =>
              checkbox.dataset.execution
                ? candidate.id === checkbox.dataset.execution
                : candidate.definition === checkbox.dataset.group &&
                  candidate.reportUuid === checkbox.dataset.owner,
            );
            for (const record of records) {
              if (checkbox.checked) this.excluded.delete(record.id);
              else this.excluded.add(record.id);
            }
          }
          this.invalidate();
          this.renderReview();
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
              this.renderDetail();
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
            this.executionId = button.dataset.point!;
            this.renderDetail();
          }
        },
        { signal },
      );
      this.element("chart").addEventListener(
        "click",
        (event) => {
          const bounds = this.element("chart").getBoundingClientRect();
          const horizontal = event.clientX - bounds.left;
          const vertical = event.clientY - bounds.top;
          const closest = [...this.points].sort(
            (left, right) =>
              Math.hypot(
                left.horizontal - horizontal,
                left.vertical - vertical,
              ) -
              Math.hypot(
                right.horizontal - horizontal,
                right.vertical - vertical,
              ),
          )[0];
          if (closest) {
            this.executionId = closest.id;
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
            (point) => point.id === this.executionId,
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
            this.executionId = next.id;
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
        if (this.data) this.drawChart();
      });
      this.observer.observe(this.element("workspace"));
    }

    private element(role: string): HTMLElement {
      return this.root.querySelector<HTMLElement>(`[data-role="${role}"]`)!;
    }
    private input(role: string): HTMLInputElement {
      return this.element(role) as HTMLInputElement;
    }
    private project(): string | null {
      const value = this.input("project").value;
      return value === "" ? null : (this.projects[Number(value)] ?? null);
    }
    private message(text: string, error = false) {
      this.element("message").textContent = text;
      this.element("message").classList.toggle("trend-error", error);
    }
    private invalidate(search = false) {
      this.data = null;
      this.executionId = "";
      this.points = [];
      this.element("workspace").hidden = true;
      (this.element("reports") as HTMLDetailsElement).open = true;
      if (search) {
        this.abort.abort();
        this.sequence++;
        this.preview = null;
        this.loading = false;
        this.element("reports").hidden = true;
        this.element("search-summary").textContent = "";
        this.input("apply").disabled = false;
      }
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
      try {
        const catalog = await this.options!.catalog(this.abort.signal);
        if (this.destroyed) return;
        const bounds = this.setBounds(catalog);
        this.message(bounds.rangeStart ? "" : "No reports available.");
        this.input("apply").disabled = !bounds.rangeStart;
        this.input("test-query").focus();
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
      const testQuery = this.input("test-query").value.trim();
      const invalid =
        TrendModel.validateFilters(filters) ||
        TrendModel.validateTestQuery(testQuery);
      if (invalid) {
        this.message(invalid, true);
        return;
      }
      this.invalidate(true);
      this.abort = new AbortController();
      const sequence = ++this.sequence;
      this.loading = true;
      this.input("apply").disabled = true;
      this.message("Reading report matches...");
      try {
        const catalog = await this.options.catalog(this.abort.signal);
        if (sequence !== this.sequence || this.destroyed) return;
        const bounds = this.setBounds(catalog);
        if (!this.edited.rangeStart) filters.rangeStart = bounds.rangeStart;
        if (!this.edited.rangeEnd) filters.rangeEnd = bounds.rangeEnd;
        const invalidBounds = TrendModel.validateFilters(filters);
        if (invalidBounds) throw new Error(invalidBounds);
        const matches = await jsonRequest<TrendData.Catalog>(
          `/api/report-search?${new URLSearchParams(filters)}`,
          this.abort.signal,
        );
        const reportUuids = [...matches.current, ...matches.archive].map(
          (report) => report.uuid,
        );
        const preview = await jsonRequest<TrendData.Preview>(
          "/api/trends",
          this.abort.signal,
          { reportUuids, testQuery },
        );
        if (sequence !== this.sequence || this.destroyed) return;
        this.filters = filters;
        this.preview = preview;
        this.selected = new Set(preview.reports.map((report) => report.uuid));
        this.excluded.clear();
        this.projects = [
          ...new Set(preview.candidates.map((candidate) => candidate.project)),
        ].sort();
        this.element("project").innerHTML =
          '<option value="">Select a project</option>' +
          this.projects
            .map(
              (project, index) =>
                `<option value="${index}">${escape(project || "(unnamed project)")}</option>`,
            )
            .join("");
        this.input("project").value = this.projects.length === 1 ? "0" : "";
        this.element("reports").hidden = !preview.reports.length;
        this.element("search-summary").textContent =
          `${testQuery} / ${filters.query || "Any metadata"}`;
        this.renderReview();
        if (this.projects.length > 1) this.input("project").focus();
      } catch (error) {
        if (
          sequence === this.sequence &&
          !this.destroyed &&
          (error as Error).name !== "AbortError"
        )
          this.message((error as Error).message, true);
      } finally {
        if (sequence === this.sequence && !this.destroyed) {
          this.loading = false;
          this.input("apply").disabled = false;
        }
      }
    }

    private renderReview() {
      if (!this.preview) return;
      const project = this.project();
      const result = TrendModel.review(
        this.preview,
        project,
        this.selected,
        this.excluded,
      );
      const count = (state: string) =>
        result.rows.filter((row) => row.state === state).length;
      this.input("generate").disabled = !result.canGenerate;
      const projectRequired = project === null && this.projects.length > 0;
      this.element("project-required").hidden = !projectRequired;
      this.element("project-field").classList.toggle(
        "needs-selection",
        projectRequired,
      );
      this.element("review-table").hidden = projectRequired;
      this.element("generation-status").textContent = projectRequired
        ? "Project required"
        : count("conflict") + count("unavailable") > 0
          ? `${countLabel(count("conflict") + count("unavailable"), "report")} need review`
          : result.canGenerate
            ? "Ready to generate"
            : "No included matches";
      this.element("generation-status").className = result.canGenerate
        ? "decrease"
        : "muted";
      this.element("report-summary").textContent = projectRequired
        ? `${countLabel(this.preview.reports.length, "report")} / ${countLabel(this.projects.length, "project")}`
        : [
            countLabel(this.preview.reports.length, "report"),
            ...["ready", "conflict", "missing", "unavailable", "excluded"]
              .filter((state) => count(state))
              .map((state) =>
                state === "conflict"
                  ? countLabel(count(state), "conflict")
                  : `${count(state)} ${state === "missing" ? "no match" : state}`,
              ),
          ].join(" / ");
      this.message(
        !this.preview.reports.length
          ? "No reports match these filters."
          : !this.preview.candidates.length
            ? "No title matches in the readable reports."
            : project === null
              ? ""
              : !result.canGenerate
                ? "Resolve or exclude the highlighted conflicts before generating."
                : "",
        !result.canGenerate && project !== null,
      );
      const container = this.element("report-rows");
      const expanded = new Set(
        Array.from(
          container.querySelectorAll<HTMLDetailsElement>("details[open]"),
        ).map((details) => details.dataset.review),
      );
      const active = document.activeElement as HTMLElement | null;
      const focus =
        active && container.contains(active) ? active.dataset.focus : undefined;
      const labels: Record<string, string> = {
        ready: "Ready",
        conflict: "Conflict",
        missing: "No title match",
        unavailable: "Cannot validate",
        excluded: "Excluded by user",
      };
      container.innerHTML = result.rows
        .map((row) => {
          const { report, groups, observations, state } = row;
          const invalid = state === "conflict" || state === "unavailable";
          const groupCount = groups.filter(
            (group) => group.included.length,
          ).length;
          return `<tr class="${invalid ? "trend-conflict" : ""}" data-state="${state}"><td><input type="checkbox" data-report="${escape(report.uuid)}" data-focus="report-${escape(report.uuid)}" aria-label="Include report ${escape(report.name)}" ${this.selected.has(report.uuid) ? "checked" : ""}></td><td><strong>${escape(report.name)}</strong><div>${escape(calendarDate(report.timestamp))}</div><div class="muted">${escape(report.metadata)} / ${escape(report.scope)}</div><div class="muted">Catalog: ${escape(calendarDate(report.createdAt))}</div></td><td>
          <details data-review="${escape(report.uuid)}" ${expanded.has(report.uuid) || invalid ? "open" : ""}><summary><strong>${labels[state]}</strong>${
            observations.length
              ? ` / ${countLabel(groupCount, "test")} / ${countLabel(observations.length, "execution")} / ${countLabel(
                  observations.reduce(
                    (sum, record) => sum + record.attempts.length,
                    0,
                  ),
                  "attempt",
                )}`
              : ""
          }</summary>
          ${report.issue ? `<p class="trend-error">${escape(report.issue)}</p>` : ""}
          ${groups
            .map((group) => {
              const source = group.records[0];
              return `<div class="trend-candidate"><label><input type="checkbox" data-group="${escape(group.key)}" data-owner="${escape(report.uuid)}" data-focus="group-${escape(report.uuid)}-${escape(group.key)}" data-partial="${group.included.length > 0 && group.included.length < group.records.length}" aria-label="Include test ${escape(source.title)} in ${escape(report.name)}" ${group.included.length ? "checked" : ""} ${this.selected.has(report.uuid) ? "" : "disabled"}><strong>${escape(source.title)}</strong></label><p class="muted">${escape(sourceLabel(source))}</p>
            ${group.invalid ? '<p class="trend-error">Repeat identity unavailable or duplicated. Exclude conflicting execution records.</p>' : ""}
            ${group.records
              .map(
                (record) =>
                  `<div class="trend-record"><label><input type="checkbox" data-execution="${escape(record.id)}" data-focus="execution-${escape(record.id)}" aria-label="Include execution ${escape(record.testId)}" ${!this.excluded.has(record.id) ? "checked" : ""} ${this.selected.has(report.uuid) ? "" : "disabled"}>${escape(repeatLabel(record))} / ${escape(TrendModel.outcome(record))}</label><span class="muted">${escape(calendarDate(record.attempts.find((attempt) => attempt.startTime)?.startTime || report.timestamp))}</span><span>${
                    record.attempts
                      .map(
                        (attempt) =>
                          `${attempt.retry ? `Retry ${attempt.retry}` : "Run"}: ${TrendModel.duration(attempt.duration)} (${attempt.status})`,
                      )
                      .map(escape)
                      .join(" / ") || "No attempts"
                  }</span>${this.link(report, record, "Open test")}</div>`,
              )
              .join("")}</div>`;
            })
            .join("")}</details></td></tr>`;
        })
        .join("");
      container
        .querySelectorAll<HTMLInputElement>('[data-partial="true"]')
        .forEach((input) => {
          input.indeterminate = true;
        });
      if (focus)
        container
          .querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus)}"]`)
          ?.focus();
    }

    show(data: TrendData.Dataset, snapshot?: TrendData.Snapshot) {
      this.data = data;
      this.executionId = "";
      if (snapshot) {
        this.metric = snapshot.metric;
        this.filters = snapshot.filters;
        this.element("heading").textContent = "Test Trend Snapshot";
        this.element("subtitle").textContent =
          `Captured ${calendarDate(snapshot.exportedAt)} / ${snapshot.filters.query || "Any metadata"} / ${snapshot.filters.rangeStart || "Any date"} to ${snapshot.filters.rangeEnd || "Any date"}`;
      }
      this.element("workspace").hidden = false;
      this.message("");
      this.renderDetail();
    }
    private link(
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
      return `<a href="/api/trends/reports/${encodeURIComponent(report.uuid)}/test?${escape(query)}" target="_blank" rel="noopener" class="trend-link" aria-label="${escape(label)} for ${escape(observation.title)}" title="Open this test attempt in a new tab">${escape(label)}${externalIcon}</a>`;
    }
    private renderDetail() {
      const series = this.data?.series[0];
      if (!series || !this.data) return;
      const stats = TrendModel.statistics(
        series,
        this.data.reports,
        this.metric,
      );
      if (!stats.runs.some((run) => run.id === this.executionId))
        this.executionId = stats.latestId ?? "";
      this.element("title").textContent = series.title;
      const exclusions = this.data.selection;
      this.element("context").textContent = [
        series.project || "(unnamed project)",
        `Read ${calendarDate(this.data.generatedAt)}`,
        ...(exclusions?.excludedReports
          ? [`${countLabel(exclusions.excludedReports, "report")} excluded`]
          : []),
        ...(exclusions?.excludedExecutions
          ? [
              `${countLabel(exclusions.excludedExecutions, "execution")} excluded`,
            ]
          : []),
      ].join(" / ");
      this.element("series-status").textContent =
        `${countLabel(stats.executions, "execution")} / ${countLabel(stats.reportCount, "report")}${stats.reportCount === 1 ? " / Cross-report trend not available yet" : stats.baseline === null ? " / Insufficient baseline" : ""}`;
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
        `${stats.runs.filter((run) => run.observation?.passed != null).length} passing / ${this.data.reports.length} included reports`;
      const selected = stats.runs.find((run) => run.id === this.executionId);
      if (selected) {
        const { report, observation, timestamp, timeSource } = selected;
        const successful = observation
          ? [...observation.attempts]
              .reverse()
              .find((attempt) => attempt.status === "passed")
          : undefined;
        const index = this.metric === "passed" ? (successful?.index ?? 0) : 0;
        this.element("selected-run").innerHTML =
          `<div class="trend-section-head"><strong>${escape(calendarDate(timestamp))}</strong>${this.link(report, observation, "Open test", index)}</div>
          ${observation ? `<p><strong>${escape(observation.title)}</strong></p><p class="muted">${escape(sourceLabel(observation))}</p><p>${escape(repeatLabel(observation))}</p>` : ""}
          <p>${escape(report.issue ? "Report unavailable" : TrendModel.outcome(observation))}${observation?.total != null ? ` / Total ${TrendModel.duration(observation.total)}` : ""}</p><p class="muted">${escape(report.name)} / ${escape(report.metadata)} / ${escape(report.scope)}${timeSource !== "attempt" ? ` / ${escape(timeSource)} timestamp fallback` : ""}</p>
          ${observation?.attempts.map((attempt) => `<div class="trend-attempt"><span>${attempt.retry ? `Retry ${attempt.retry}` : "Run"}: ${TrendModel.duration(attempt.duration)} / ${escape(attempt.status)}</span>${this.link(report, observation, "Open attempt", attempt.index)}</div>`).join("") ?? ""}`;
      }
      this.element("history").innerHTML = [...stats.runs]
        .reverse()
        .map(
          ({ id, report, observation, timestamp }) =>
            `<tr class="${id === this.executionId ? "selected" : ""}"><td><button type="button" class="trend-point" data-point="${escape(id)}" aria-pressed="${id === this.executionId}">${escape(calendarDate(timestamp))}${observation?.repeat != null ? ` / repeat ${observation.repeat}` : ""}</button></td><td>${escape(report.issue ? "Unavailable" : TrendModel.outcome(observation))}</td><td>${TrendModel.duration(observation?.passed ?? null)}</td><td>${TrendModel.duration(observation?.total ?? null)}</td><td>${escape(report.name)} ${this.link(report, observation, "Open test")}</td></tr>`,
        )
        .join("");
      this.drawChart();
    }
    private drawChart() {
      if (!this.data || this.element("workspace").hidden) return;
      const canvas = this.element("chart") as HTMLCanvasElement;
      const { width, height } = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const context = canvas.getContext("2d")!;
      context.scale(ratio, ratio);
      const stats = TrendModel.statistics(
        this.data.series[0],
        this.data.reports,
        this.metric,
      );
      const runs = stats.runs;
      this.points = [];
      const displayed = runs.map(
        ({ observation }) =>
          observation?.[this.metric] ??
          observation?.attempts.find((attempt) => attempt.status !== "skipped")
            ?.duration ??
          null,
      );
      const maximum = displayed.reduce<number>(
        (maximum, value) => Math.max(maximum, value ?? 0),
        Math.max(60000, stats.baseline ?? 0),
      );
      const ceiling = Math.ceil(maximum / 60000) * 60000;
      const left = 48,
        right = width - 16,
        top = 18,
        bottom = height - 34;
      const vertical = (value: number) =>
        bottom - (value / ceiling) * (bottom - top);
      const times = runs.map((run) => Date.parse(run.timestamp));
      const validTimes = times.filter(Number.isFinite);
      const first = validTimes.reduce(
        (minimum, value) => Math.min(minimum, value),
        Infinity,
      );
      const last = validTimes.reduce(
        (maximum, value) => Math.max(maximum, value),
        -Infinity,
      );
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
        const value = (ceiling * tick) / 4,
          position = vertical(value);
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
        if (value == null) {
          connected = false;
          return;
        }
        if (connected) context.lineTo(horizontal(index), vertical(value));
        else context.moveTo(horizontal(index), vertical(value));
        connected = true;
      });
      context.stroke();
      const dateLabels = runs.map(({ timestamp }) =>
        timestamp
          ? new Date(timestamp).toLocaleDateString(undefined, {
              timeZone: "UTC",
              month: "short",
              day: "numeric",
            })
          : "Missing",
      );
      const finalLabelLeft =
        right - context.measureText(dateLabels.at(-1) ?? "").width;
      let previousLabelRight = -Infinity;
      runs.forEach(({ id, observation }, index) => {
        const position = horizontal(index),
          value = displayed[index];
        this.points.push({
          horizontal: position,
          vertical: value === null ? bottom : vertical(value),
          id,
        });
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
          context.beginPath();
          if (failed) {
            context.moveTo(position - 4, point - 4);
            context.lineTo(position + 4, point + 4);
            context.moveTo(position + 4, point - 4);
            context.lineTo(position - 4, point + 4);
            context.stroke();
          } else {
            context.arc(position, point, 4, 0, Math.PI * 2);
            context.fill();
          }
          if (id === this.executionId) {
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
          const label = dateLabels[index];
          const labelWidth = context.measureText(label).width;
          const labelLeft = Math.max(
            left,
            Math.min(right - labelWidth, position - labelWidth / 2),
          );
          if (
            labelLeft < previousLabelRight + 12 ||
            (index !== runs.length - 1 &&
              labelLeft + labelWidth > finalLabelLeft - 12)
          )
            return;
          context.fillStyle = "#9da7b3";
          context.textAlign = "left";
          context.fillText(label, labelLeft, height - 11);
          previousLabelRight = labelLeft + labelWidth;
        }
      });
    }
    private async export() {
      if (!this.data || this.downloading || !this.options) return;
      const data = this.data;
      const series = data.series[0];
      this.downloading = true;
      this.input("export").disabled = true;
      const snapshot = TrendModel.selectedSnapshot(
        data,
        series,
        data.reports,
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
        if (this.destroyed || data !== this.data) return;
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
      this.preview = null;
      this.selected.clear();
      this.excluded.clear();
      this.points = [];
    }
  }

  export function showSnapshot(
    root: HTMLElement,
    snapshot: TrendData.Snapshot,
  ): void {
    if (
      snapshot.schemaVersion !== 2 ||
      snapshot.data.schemaVersion !== 2 ||
      snapshot.data.series.length !== 1
    ) {
      root.textContent = "Unsupported trend snapshot.";
      return;
    }
    new Viewer(root).show(snapshot.data, snapshot);
  }

  const pageRoot = document.getElementById("trends-page-root");
  if (pageRoot) {
    const viewer = new Viewer(pageRoot, {
      catalog: (signal) =>
        jsonRequest<TrendData.Catalog>("/api/reports", signal),
    });
    window.addEventListener("pagehide", (event) => {
      if (!event.persisted) viewer.close();
    });
    void viewer.initialize();
  }
}
