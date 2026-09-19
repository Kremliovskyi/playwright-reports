async (page) => {
  const verify = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.reload();
  await page.locator("#current-tbody .report-row").first().waitFor();
  const origin = await page.evaluate(() => location.origin);
  const catalog = await (
    await page.request.get(origin + "/api/reports")
  ).json();
  const dates = [...catalog.current, ...catalog.archive]
    .map((report) => report.createdAt.slice(0, 10))
    .sort();
  await page.getByRole("button", { name: "Open search", exact: true }).click();
  verify(
    (await page.locator("#search-range-start").inputValue()) === dates[0],
    "Oldest full-catalog default",
  );
  verify(
    (await page.locator("#search-range-end").inputValue()) === dates.at(-1),
    "Newest full-catalog default",
  );
  verify(
    !(await page.locator("#search-toggle-btn").getAttribute("class")).includes(
      "search-toggle-applied",
    ),
    "Date defaults must not apply Search",
  );
  await page.locator("#search-input").fill("DEV NA");
  const searchResponse = page.waitForResponse((response) =>
    response.url().includes("/api/report-search?"),
  );
  await page
    .getByRole("button", { name: "Search reports", exact: true })
    .click();
  verify((await searchResponse).ok(), "Search apply");
  await page.getByRole("button", { name: "Close search", exact: true }).click();
  const dashboard = page;
  const trendsTab = page.context().waitForEvent("page");
  await page
    .getByRole("button", { name: "Open Trends in a new tab", exact: true })
    .click();
  page = await trendsTab;
  const trendsPage = page;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForURL("**/trends.html");
  await page.setViewportSize({ width: 1440, height: 900 });
  verify(
    await page.evaluate(() => window.opener === null),
    "New tab has no opener",
  );
  verify(
    (await dashboard.locator("dialog.trend-dialog").count()) === 0,
    "Dashboard does not create a dialog",
  );
  verify(
    await dashboard.locator("#refresh-btn").isEnabled(),
    "Dashboard stays usable while Trends is open",
  );
  const view = page.getByRole("main", { name: "Test Trends", exact: true });
  const role = (name) => view.locator(`[data-role="${name}"]`);
  const expand = async (name) => {
    if (!(await role(name).evaluate((element) => element.open)))
      await role(name).locator(":scope > summary").click();
  };
  const chartInView = async () => {
    const bounds = await role("chart").boundingBox();
    verify(
      bounds &&
        bounds.y >= 0 &&
        bounds.y + bounds.height <= page.viewportSize().height,
      "Generated chart is fully in view without manual scrolling",
    );
    verify(
      await role("title").evaluate(
        (element) => element === document.activeElement,
      ),
      "Generated chart heading receives focus",
    );
    verify(
      !(await role("reports").evaluate((element) => element.open)),
      "Review collapses after generation",
    );
    verify(
      !(await role("search-zone").evaluate((element) => element.open)),
      "Search collapses after generation",
    );
  };
  const search = async (query, metadata = "DEV NA") => {
    await expand("search-zone");
    await role("metadata").fill(metadata);
    await role("test-query").fill(query);
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/api/trends"),
    );
    await role("apply").click();
    verify((await response).ok(), "Preview API response");
    await page.waitForFunction(
      () => !document.querySelector('[data-role="apply"]').disabled,
    );
  };
  const chooseProject = async () => {
    await role("project").selectOption({ label: "all-falcons" });
  };
  const excludeCollision = async () => {
    await view
      .getByRole("checkbox", {
        name: "Include test e2eExampleTC010 - another workflow in daily-05",
        exact: true,
      })
      .uncheck();
  };
  await search("e2eExampleTC01");
  verify(
    await role("workspace").isHidden(),
    "Search must not generate a chart",
  );
  verify(await role("generate").isDisabled(), "Project choice required");
  verify(
    await role("project-required").isVisible(),
    "Required project is visible",
  );
  verify(
    await role("project").evaluate(
      (element) => element === document.activeElement,
    ),
    "Project selection receives focus",
  );
  verify(
    await role("review-table").isHidden(),
    "Project selection precedes report review",
  );
  await page.screenshot({
    path: "tests/.browser-results/trends-project-required.png",
  });
  await chooseProject();
  verify(
    await role("project-required").isHidden(),
    "Required state clears after project selection",
  );
  verify(
    await role("generate").isDisabled(),
    "Prefix collision requires review",
  );
  verify(
    (await role("report-rows").locator('tr[data-state="conflict"]').count()) ===
      1,
    "Conflict is explicit",
  );
  await page.screenshot({
    path: "tests/.browser-results/trends-review-desktop.png",
  });
  await excludeCollision();
  verify(
    await role("generate").isEnabled(),
    "Manual candidate exclusion resolves conflict",
  );
  await role("generate").click();
  await role("workspace").waitFor({ state: "visible" });
  await chartInView();
  verify(
    (await role("latest").textContent()) === "4m 00s",
    "Latest passed duration",
  );
  verify((await role("baseline").textContent()) === "1m 58s", "Baseline");
  verify((await role("change").textContent()) === "+103%", "Baseline change");
  verify(
    (await role("report-summary").textContent()).includes("12 ready"),
    "Report count",
  );
  await page.screenshot({ path: "tests/.browser-results/trends-desktop.png" });
  await role("history")
    .locator("tr")
    .filter({ hasText: "daily-09" })
    .locator("button")
    .click();
  verify(
    (await role("selected-run").textContent()).includes("8m 12s"),
    "Failed retries show total",
  );
  const popupPromise = page.waitForEvent("popup");
  await role("selected-run")
    .getByRole("link", { name: /^Open test/ })
    .click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  verify(
    popup.url().includes("testId=daily-test-8&run=0"),
    "Exact report test deep link",
  );
  await popup.close();
  verify(
    (await role("selected-run").textContent()).includes(
      "tests/moved/orders.spec.ts:10:1",
    ),
    "Original moved path remains inspectable",
  );
  await view.locator('[data-metric="total"]').click();
  verify(
    (await view
      .locator('[data-metric="total"]')
      .getAttribute("aria-pressed")) === "true",
    "Total metric control",
  );
  await view.locator('[data-metric="passed"]').click();
  await search("e2eExampleTC03");
  await role("generate").click();
  verify(
    (await role("series-status").textContent()).includes(
      "Cross-report trend not available yet",
    ),
    "Single-run state",
  );
  await search("e2eExampleTC01");
  await chooseProject();
  await excludeCollision();
  await role("generate").click();
  await expand("reports");
  verify(
    !(await view
      .getByRole("checkbox", {
        name: "Include test e2eExampleTC010 - another workflow in daily-05",
        exact: true,
      })
      .isChecked()),
    "Review preserves candidate exclusions",
  );
  await role("report-rows").locator('[data-report="daily-uuid-11"]').uncheck();
  verify(
    await role("workspace").isHidden(),
    "Selection invalidates chart and export",
  );
  await role("generate").click();
  verify(
    (await role("latest").textContent()) === "3m 46s",
    "Excluding latest report recomputes values",
  );
  await expand("reports");
  await role("report-rows").locator('[data-report="daily-uuid-11"]').check();
  await role("generate").click();
  await page.evaluate(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      if (blob.type.startsWith("text/html")) window.trendExport = blob.text();
      return original.call(URL, blob);
    };
  });
  const downloadPromise = page.waitForEvent("download");
  await role("export").click();
  const download = await downloadPromise;
  await download.saveAs("tests/.browser-results/trend-export.html");
  const html = await page.evaluate(() => window.trendExport);
  verify(
    !html.includes("e2eExampleTC02") &&
      !html.includes("e2eExampleTC03") &&
      !html.includes("e2eExampleTC010") &&
      !html.includes("other-project"),
    "Export contains only selected test",
  );
  const exportedData = JSON.parse(
    html.match(/id="trend-snapshot-data">([\s\S]*?)<\/script>/)[1],
  );
  verify(
    exportedData.data.reports.length === 12,
    "Export includes selected reports",
  );
  verify(
    exportedData.data.series[0].observations.every(
      (observation) => observation.testId === "",
    ),
    "Export omits live test link IDs",
  );
  const offlineContext = await page
    .context()
    .browser()
    .newContext({ offline: true });
  const offline = await offlineContext.newPage();
  const offlineErrors = [];
  const offlineRequests = [];
  offline.on("pageerror", (error) => offlineErrors.push(error.message));
  offline.on("request", (request) => offlineRequests.push(request.url()));
  const offlinePath = `${await download.path()}.html`;
  await download.saveAs(offlinePath);
  await offline.goto(`file://${offlinePath}`);
  await offline.locator('[data-role="chart"]').waitFor();
  verify(
    (await offline.locator('[data-role="latest"]').textContent()) === "4m 00s",
    "Offline export value parity",
  );
  await offline.locator('[data-metric="total"]').click();
  await offline
    .locator('[data-role="history"] [data-point="execution-2"]')
    .click();
  verify(
    (await offline.locator("a").count()) === 0,
    "Offline snapshot has no source links",
  );
  verify(
    offlineRequests.filter((url) => !url.startsWith("file:")).length === 0,
    "Offline export must make zero network requests",
  );
  verify(
    offlineErrors.length === 0,
    "Offline script errors: " + offlineErrors.join(", "),
  );
  await offline.screenshot({
    path: "tests/.browser-results/trends-offline.png",
    fullPage: true,
  });
  await offlineContext.close();
  await search("repeatCase");
  verify(await role("generate").isDisabled(), "Copied repetition conflicts");
  await view
    .getByRole("checkbox", {
      name: "Include execution copied-repeat",
      exact: true,
    })
    .uncheck();
  await role("generate").click();
  verify(
    (await role("history").locator("tr").count()) === 16,
    "Six repetitions and ten missing-report gaps",
  );
  const repeatedRow = role("history")
    .locator("tr")
    .filter({ hasText: "daily-07" });
  verify((await repeatedRow.count()) === 3, "One history point per repetition");
  await repeatedRow.first().locator("button").click();
  verify(
    (await role("selected-run").locator(".trend-attempt").count()) === 2,
    "Retry attempts stay within each point",
  );
  const selectedId = await role("history")
    .locator('[aria-pressed="true"]')
    .getAttribute("data-point");
  await role("chart").focus();
  await page.keyboard.press("ArrowLeft");
  verify(
    (await role("history")
      .locator('[aria-pressed="true"]')
      .getAttribute("data-point")) !== selectedId,
    "Keyboard reaches equal-timestamp repetitions",
  );
  await expand("reports");
  await view
    .getByRole("checkbox", {
      name: "Include execution copied-repeat",
      exact: true,
    })
    .check();
  verify(
    (await role("generate").isDisabled()) &&
      (await role("workspace").isHidden()),
    "Restoring a conflicting record blocks regeneration",
  );
  await search("e2eExampleTC01");
  await chooseProject();
  await excludeCollision();
  await role("generate").click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expand("reports");
    await role("generate").click();
    await chartInView();
    const bounds = await view.boundingBox();
    verify(
      bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
      "Mobile page fits",
    );
    const layout = await view.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    verify(layout.scroll <= layout.client + 1, "No mobile page overflow");
    await role("chart").scrollIntoViewIfNeeded();
    const nonblank = await role("chart").evaluate((canvas) =>
      canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((value) => value !== 0),
    );
    verify(nonblank, "Chart pixels must be nonblank");
    await page.screenshot({
      path: `tests/.browser-results/trends-mobile-${width}.png`,
    });
    await search("e2eExampleTC01");
    await page.screenshot({
      path: `tests/.browser-results/trends-project-mobile-${width}.png`,
    });
    await chooseProject();
    await excludeCollision();
    await role("generate").click();
  }
  page = dashboard;
  await page.bringToFront();
  verify(
    (await page.locator("#search-toggle-btn").getAttribute("class")).includes(
      "search-toggle-applied",
    ),
    "Trends must preserve Search filter",
  );
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator("#utilities-toggle").click();
    await page.locator("#settings-btn").waitFor({ state: "visible" });
    const bounds = await page.locator("#utilities-panel").evaluate((panel) => ({
      left: panel.getBoundingClientRect().left,
      right: panel.getBoundingClientRect().right,
      viewport: innerWidth,
    }));
    verify(
      bounds.left >= 0 && bounds.right <= bounds.viewport,
      "Utility menu stays within viewport",
    );
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: "Open search", exact: true }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  verify(
    (await page.locator("#search-range-start").inputValue()) === dates[0],
    "Reset restores date defaults",
  );
  verify(
    !(await page.locator("#search-toggle-btn").getAttribute("class")).includes(
      "search-toggle-applied",
    ),
    "Reset removes applied filter",
  );
  await page.locator("#search-range-start").fill("2026-01-01");
  const explicitDates = page.waitForResponse(
    (response) =>
      response.url().includes("/api/report-search?") &&
      response.url().includes("rangeStart=2026-01-01"),
  );
  await page
    .getByRole("button", { name: "Search reports", exact: true })
    .click();
  verify((await explicitDates).ok(), "Explicit date filter submitted");
  await page.getByRole("button", { name: "Close search", exact: true }).click();
  await page.getByRole("button", { name: "Open search", exact: true }).click();
  verify(
    (await page.locator("#search-range-start").inputValue()) === "2026-01-01",
    "Explicit bounds survive reopening",
  );
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: "Close search", exact: true }).click();
  await page.screenshot({
    path: "tests/.browser-results/trends-header-mobile.png",
  });
  const headerBounds = await page
    .locator(".header-content")
    .evaluate((header) => ({
      right: header.getBoundingClientRect().right,
      viewport: innerWidth,
    }));
  verify(headerBounds.right <= headerBounds.viewport + 1, "Mobile header fits");
  page = trendsPage;
  await page.bringToFront();
  await page.setViewportSize({ width: 1440, height: 900 });
  await search("e2eExampleTC01", "no-matching-metadata");
  verify(
    (await role("message").textContent()).includes("No reports match"),
    "Empty report selection: " + (await role("message").textContent()),
  );
  await search("e2eExampleTC01", "");
  await chooseProject();
  verify(
    (await role("report-summary").textContent()).includes("1 unavailable"),
    "Unreadable reports are explicit, not silently ignored",
  );
  await excludeCollision();
  verify(
    await role("generate").isDisabled(),
    "Unreadable report blocks generation",
  );
  await role("report-rows").locator('[data-report="fixture-uuid"]').uncheck();
  verify(
    await role("generate").isEnabled(),
    "Excluding unreadable report allows generation",
  );
  await search("nothing-with-this-title");
  verify(
    (await role("message").textContent()).includes("No title matches"),
    "No-title-match message",
  );
  verify(await role("generate").isDisabled(), "No match cannot generate");
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/api/trends", async (route) => {
    started();
    await pending;
    await route
      .fulfill({
        json: {
          schemaVersion: 2,
          generatedAt: "stale",
          testQuery: "stale",
          reports: [],
          candidates: [],
        },
      })
      .catch(() => {});
  });
  await expand("search-zone");
  await role("metadata").fill("DEV NA");
  await role("test-query").fill("e2eExampleTC01");
  await role("apply").click();
  await requested;
  await role("test-query").fill("edited-during-search");
  verify(await role("reports").isHidden(), "Editing aborts pending review");
  release();
  await page.unroute("**/api/trends");
  await search("e2eExampleTC01");
  await chooseProject();
  await excludeCollision();
  await role("generate").click();
  await role("workspace").waitFor({ state: "visible" });
  verify(
    (await role("latest").textContent()) === "4m 00s",
    "Aborted stale request cannot replace new result",
  );
  await page.route("**/api/trends", async (route) => {
    const response = await route.fetch();
    const preview = await response.json();
    preview.reports.push(
      ...Array.from({ length: 8 }, (_, index) => ({
        ...preview.reports[0],
        uuid: `additional-${index}`,
        name: `additional-report-${index}`,
      })),
    );
    await route.fulfill({ json: preview });
  });
  await search("e2eExampleTC01");
  await chooseProject();
  await excludeCollision();
  verify(
    (await role("report-rows").locator("tr").count()) === 20,
    "Twenty reports remain reviewable",
  );
  await page.screenshot({
    path: "tests/.browser-results/trends-review-20.png",
  });
  await role("generate").click();
  await chartInView();
  const collapsedHeading = await role("reports")
    .locator(":scope > summary")
    .boundingBox();
  verify(
    collapsedHeading.y >= 0,
    "Desktop retains the collapsed review summary above the chart",
  );
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-role="chart"]');
    const context = canvas.getContext("2d");
    const original = context.fillText;
    window.trendAxisLabels = [];
    context.fillText = function (text, horizontal, vertical) {
      if (vertical > canvas.getBoundingClientRect().height - 20)
        window.trendAxisLabels.push({
          left: horizontal,
          right: horizontal + context.measureText(text).width,
        });
      return original.call(this, text, horizontal, vertical);
    };
    document.querySelector('[data-metric="total"]').click();
    context.fillText = original;
  });
  const axisLabels = await page.evaluate(() => window.trendAxisLabels);
  verify(
    axisLabels.length > 0 &&
      axisLabels.every(
        (label, index) => !index || label.left > axisLabels[index - 1].right,
      ),
    "Chart date labels do not overlap for same-time reports",
  );
  await page.screenshot({
    path: "tests/.browser-results/trends-generated-20.png",
  });
  await page.unroute("**/api/trends");
  await page.reload();
  await role("test-query").waitFor();
  verify(
    await role("workspace").isHidden(),
    "Direct reload starts a fresh Trends page",
  );
  await page.close();
  verify(errors.length === 0, "Browser script errors: " + errors.join(", "));
  return {
    standaloneTab: true,
    requiredProject: true,
    collapsedReview: true,
    twentyReports: true,
    searchDefaults: true,
    independentFilters: true,
    retryMetrics: true,
    newTest: true,
    reportSelection: true,
    exactLink: true,
    selectedOnlyExport: true,
    offlineInteraction: true,
    mobile: true,
    keyboard: true,
    errors,
  };
};
