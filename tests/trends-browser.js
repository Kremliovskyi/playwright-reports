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
  await page.getByRole("button", { name: "Open Trends", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Test Trends", exact: true });
  const role = (name) => dialog.locator(`[data-role="${name}"]`);
  await role("metadata").fill("DEV NA");
  await role("apply").click();
  await role("workspace").waitFor({ state: "visible" });
  verify(
    (await role("latest").textContent()) === "4m 00s",
    "Latest passed duration",
  );
  verify((await role("baseline").textContent()) === "1m 58s", "Baseline");
  verify((await role("change").textContent()) === "+103%", "Baseline change");
  verify(
    (await role("report-summary").textContent()).includes("12 of 12"),
    "Report count",
  );
  await page.screenshot({ path: "tests/.browser-results/trends-desktop.png" });
  await role("history").locator('[data-point="daily-uuid-8"]').click();
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
  await dialog.locator('[data-metric="total"]').click();
  verify(
    (await dialog
      .locator('[data-metric="total"]')
      .getAttribute("aria-pressed")) === "true",
    "Total metric control",
  );
  await dialog.locator('[data-metric="passed"]').click();
  await role("search").fill("TC03");
  verify(
    (await role("series-status").textContent()).includes(
      "1 run; trend not available yet",
    ),
    "Single-run state",
  );
  await role("search").fill("TC01");
  await role("report-summary").click();
  await role("report-rows").locator('[data-report="daily-uuid-11"]').uncheck();
  verify(
    (await role("latest").textContent()) === "3m 46s",
    "Excluding latest report recomputes values",
  );
  await role("report-rows").locator('[data-report="daily-uuid-11"]').check();
  await role("report-summary").click();
  await role("history").locator('[data-point="daily-uuid-11"]').click();
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
    !html.includes("e2eExampleTC02") && !html.includes("e2eExampleTC03"),
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
  await offline.setContent(html);
  await offline.locator('[data-role="chart"]').waitFor();
  verify(
    (await offline.locator('[data-role="latest"]').textContent()) === "4m 00s",
    "Offline export value parity",
  );
  await offline.locator('[data-metric="total"]').click();
  await offline
    .locator('[data-role="history"] [data-point="report-2"]')
    .click();
  verify(
    (await offline.locator("a").count()) === 0,
    "Offline snapshot has no source links",
  );
  verify(
    offlineRequests.length === 0,
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
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await dialog.boundingBox();
    verify(
      bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
      "Mobile dialog fits",
    );
    const layout = await dialog.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    verify(layout.scroll <= layout.client + 1, "No mobile dialog overflow");
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
  }
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  verify(
    (await page.locator("#search-toggle-btn").getAttribute("class")).includes(
      "search-toggle-applied",
    ),
    "Trends must preserve Search filter",
  );
  verify(
    await page
      .locator("#trends-btn")
      .evaluate((element) => element === document.activeElement),
    "Close restores trigger focus",
  );
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator("#utilities-toggle").click();
    await page.locator("#settings-btn").waitFor({ state: "visible" });
    const bounds = await page
      .locator("#utilities-panel")
      .evaluate((panel) => ({
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
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByRole("button", { name: "Open Trends", exact: true }).click();
  await role("metadata").fill("no-matching-metadata");
  await role("apply").click();
  await role("message").filter({ hasText: "No reports match" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open Trends", exact: true }).click();
  await role("apply").click();
  await role("workspace").waitFor({ state: "visible" });
  verify(
    (await role("message").textContent()).includes("unavailable"),
    "Unreadable reports are explicit, not silently ignored",
  );
  await page.keyboard.press("Escape");
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
          schemaVersion: 1,
          generatedAt: "stale",
          reports: [],
          series: [],
        },
      })
      .catch(() => {});
  });
  await page.getByRole("button", { name: "Open Trends", exact: true }).click();
  await role("metadata").fill("DEV NA");
  await role("apply").click();
  await requested;
  await page.keyboard.press("Escape");
  release();
  await page.unroute("**/api/trends");
  await page.getByRole("button", { name: "Open Trends", exact: true }).click();
  await role("metadata").fill("DEV NA");
  await role("apply").click();
  await role("workspace").waitFor({ state: "visible" });
  verify(
    (await role("latest").textContent()) === "4m 00s",
    "Closed stale request cannot replace new result",
  );
  await page.keyboard.press("Escape");
  verify(errors.length === 0, "Browser script errors: " + errors.join(", "));
  return {
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
