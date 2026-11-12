const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { startHub } = require("../helpers/hub.cjs");

for (const [scenario, seed] of [
  ["archive", ""],
  ["artifact", "browser"],
  ["runner-titles", ""],
  ["trends", "trends"],
  ["analysis-import", ""],
]) {
  test(`${scenario} browser workflow`, async ({ browser }) => {
    const cleanup = [];
    const hub = await startHub({ after: fn => cleanup.push(fn) }, seed,
      scenario === "analysis-import" ? { ARTIFACT_TEST_REAL_ANALYZER: "1" } : {});
    let context;
    try {
      let url = hub.url;
      if (scenario === "analysis-import") {
        const generated = await hub.request("/api/failures", {
          reportPath: "/reports/current/fixture-report/index.html",
        });
        expect(generated.status, JSON.stringify(generated.data)).toBe(200);
        const source = path.join(hub.root, "Downloads with spaces", generated.data.analysisResult.runId);
        fs.cpSync(generated.data.runDir, source, { recursive: true });
        fs.writeFileSync(path.join(source, "final-analysis.md"), "# Final review\n\n[Missing](absent.md)");
        url += "/?source=" + encodeURIComponent(source);
      }
      context = await browser.newContext();
      const page = await context.newPage();
      fs.mkdirSync(path.join(__dirname, "../.browser-results"), { recursive: true });
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        return url.origin === hub.url ? route.continue() : route.abort();
      });
      await page.goto(url);
      await expect(page.locator("#current-tbody .report-row").first()).toBeVisible();
      const run = vm.runInThisContext(
        fs.readFileSync(path.join(__dirname, `../${scenario}-browser.js`), "utf8"),
        { filename: `${scenario}-browser.js` },
      );
      await run(page);
    } finally {
      await context?.close();
      for (const dispose of cleanup.reverse()) await dispose();
    }
  });
}

test("General preferences validates and persists the archived report limit", async ({ browser }) => {
  const cleanup = [];
  const hub = await startHub({ after: fn => cleanup.push(fn) });
  let context;
  try {
    context = await browser.newContext();
    await context.route("**/*", route =>
      new URL(route.request().url()).origin === hub.url ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    let saves = 0;
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/config" && request.method() === "POST")
        saves++;
    });
    await page.goto(hub.url);
    const modal = page.locator("#settings-modal");
    const save = modal.getByRole("button", { name: "Save changes and reload", exact: true });
    const limit = modal.getByLabel("Archived report limit", { exact: true });
    const openGeneral = async () => {
      await page.locator("#settings-btn").click();
      await expect(save).toBeEnabled();
      await modal.getByRole("button", { name: "General", exact: true }).click();
    };
    await openGeneral();
    await expect(modal.locator(".modal-tab")).toHaveText(["Paths", "BrowserStack", "Copilot", "General"]);
    await expect(limit).toHaveValue("20");
    await expect(modal.locator('[data-tab-content="copilot"]')).toBeHidden();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(modal.getByRole("button", { name: "General", exact: true })).toBeVisible();
      await expect(limit).toBeVisible();
      expect(await modal.locator(".modal-content").evaluate(element =>
        element.scrollWidth <= element.clientWidth &&
        element.getBoundingClientRect().right <= window.innerWidth,
      )).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const value of ["", "0", "-1", "1.5"]) {
      await limit.fill(value);
      await save.click();
      await expect(modal.locator("#modal-error")).toHaveText("Archived report limit must be a positive whole number.");
      await expect(save).toBeEnabled();
    }
    expect(saves).toBe(0);
    await limit.fill("37");
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    await openGeneral();
    await expect(limit).toHaveValue("20");
    for (const value of ["37", "1"]) {
      await limit.fill(value);
      await Promise.all([page.waitForEvent("load"), save.click()]);
      await expect(modal).toBeHidden();
      expect((await hub.request("/api/config", undefined, "GET")).data.archiveLimit).toBe(Number(value));
      await openGeneral();
      await expect(limit).toHaveValue(value);
    }
    expect(saves).toBe(2);
  } finally {
    await context?.close();
    for (const dispose of cleanup.reverse()) await dispose();
  }
});

test("failure analysis distinguishes failed, partial and successful outcomes", async ({ browser }) => {
  const cleanup = [];
  const hub = await startHub({ after: fn => cleanup.push(fn) });
  let context;
  try {
    context = await browser.newContext();
    await context.route("**/*", route =>
      new URL(route.request().url()).origin === hub.url ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    let result;
    await page.route("**/api/failures", route => route.fulfill({
      json: { count: 10, relativeRunDir: "tmp/synthetic-analysis", ...result },
    }));
    await page.goto(hub.url);
    const row = page.locator('.report-row[data-path="/reports/current/fixture-report/index.html"]');
    const modal = page.locator("#failures-modal");
    for (const scenario of [
      {
        result: { ai: { analyzed: 0, failed: 10 }, groupingError: "Synthetic cleanup failure" },
        outcome: "error", title: "Failure Analysis Failed", color: "rgb(248, 81, 73)",
        message: "Evidence records: 0 written, 10 failed",
      },
      {
        result: { aiError: "Synthetic engine failure" },
        outcome: "error", title: "Failure Analysis Failed", color: "rgb(248, 81, 73)",
        message: "Synthetic engine failure",
      },
      {
        result: { ai: { analyzed: 9, failed: 1 } },
        outcome: "warning", title: "Failure Analysis Completed with Warnings", color: "rgb(210, 153, 34)",
        message: "Evidence records: 9 written, 1 failed",
      },
      {
        result: { ai: { analyzed: 10, failed: 0 }, groupingError: "Synthetic grouping failure" },
        outcome: "warning", title: "Failure Analysis Completed with Warnings", color: "rgb(210, 153, 34)",
        message: "Synthetic grouping failure",
      },
      {
        result: { ai: { analyzed: 10, failed: 0 }, grouping: { problemCount: 2 } },
        outcome: "success", title: "Failure Analysis Complete", color: "rgb(46, 160, 67)",
        message: "Analyzed failures successfully!",
      },
      {
        result: { count: 0, ai: { analyzed: 0, failed: 0 } },
        outcome: "success", title: "Failure Analysis Complete", color: "rgb(46, 160, 67)",
        message: "No failures",
      },
    ]) {
      result = scenario.result;
      await row.getByRole("button", { name: "More actions" }).click();
      await row.getByRole("button", { name: "Analyze Failures" }).click();
      await expect(modal).toBeVisible();
      await expect(modal).toHaveAttribute("data-outcome", scenario.outcome);
      await expect(modal.getByRole("heading")).toHaveText(scenario.title);
      await expect(modal.locator(".digest-status-title")).toHaveCSS("color", scenario.color);
      await expect(modal).toContainText(scenario.message);
      if (scenario.outcome === "success")
        await expect(modal.locator(".digest-status-title svg")).toBeVisible();
      else
        await expect(modal.locator(".digest-status-title svg")).toBeHidden();
      await modal.getByRole("button", { name: "Dismiss", exact: true }).click();
      await expect(modal).toBeHidden();
    }
  } finally {
    await context?.close();
    for (const dispose of cleanup.reverse()) await dispose();
  }
});

for (const editingMetadata of [false, true]) {
  test(`Trends initialization does not move focus ${editingMetadata ? "while typing metadata" : "on page load"}`, async ({ browser }) => {
    const cleanup = [];
    const hub = await startHub({ after: fn => cleanup.push(fn) });
    let context;
    let releaseCatalog;
    const catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
    try {
      context = await browser.newContext();
      await context.route("**/*", route =>
        new URL(route.request().url()).origin === hub.url ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      await page.route("**/api/reports", async route => {
        await catalogGate;
        await route.continue();
      });
      await page.goto(hub.url + "/trends.html", { waitUntil: "domcontentloaded" });
      const search = page.getByRole("button", { name: "Search matches", exact: true });
      const metadata = page.getByLabel("Metadata", { exact: true });
      const title = page.getByLabel("Test title contains", { exact: true });
      await expect(search).toBeDisabled();
      await expect(title).not.toBeFocused();
      if (editingMetadata) {
        await metadata.click();
        await page.keyboard.type("DEV");
      }
      releaseCatalog();
      await expect(search).toBeEnabled();
      await expect(title).not.toBeFocused();
      if (editingMetadata) {
        await expect(metadata).toBeFocused();
        await page.keyboard.type(" NA");
        await expect(metadata).toHaveValue("DEV NA");
        await expect(title).toHaveValue("");
      }
    } finally {
      releaseCatalog();
      await context?.close();
      for (const dispose of cleanup.reverse()) await dispose();
    }
  });
}

test("dashboard keeps Refresh beside Run Tests and Search in responsive utilities", async ({ browser }) => {
  const cleanup = [];
  const hub = await startHub({ after: fn => cleanup.push(fn) });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/*", route =>
      new URL(route.request().url()).origin === hub.url ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    await page.goto(hub.url);
    await expect(page.locator("#current-tbody .report-row").first()).toBeVisible();
    const refresh = page.getByRole("button", { name: "Refresh reports", exact: true });
    const search = page.getByRole("button", { name: "Open search", exact: true });
    const utilities = page.locator("#utilities-toggle");
    await expect(page.locator("#run-tests-wrapper + #refresh-btn")).toBeVisible();
    await expect(refresh).toHaveText("Refresh");
    await expect(page.locator("#utilities-panel > #search-toggle-btn")).toBeVisible();
    await expect(search.locator("svg")).toBeVisible();
    await expect(search.locator(".utility-label")).toBeHidden();
    expect((await search.boundingBox()).width).toBe(36);
    await expect(utilities).toBeHidden();
    const refreshed = page.waitForResponse("**/api/reports");
    await refresh.click();
    expect((await refreshed).ok()).toBe(true);

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(refresh).toBeVisible();
      await expect(refresh).toHaveText("Refresh");
      if (width < 800) {
        await expect(search).toBeHidden();
        await utilities.click();
        await expect(search).toBeFocused();
        await expect(search.locator(".utility-label")).toBeVisible();
        await expect(page.locator("#settings-btn")).toBeVisible();
      }
      await search.click();
      await expect(page.locator("#search-input")).toBeFocused();
      await expect(refresh).toBeDisabled();
      await expect(utilities).toHaveAttribute("aria-expanded", "false");
      await page.getByRole("button", { name: "Close search", exact: true }).click();
      await expect(refresh).toBeEnabled();
    }
  } finally {
    await context?.close();
    for (const dispose of cleanup.reverse()) await dispose();
  }
});

test("runner uses local terminal assets and reports rejected option saves", async ({ browser }) => {
  const cleanup = [];
  const hub = await startHub({ after: fn => cleanup.push(fn) });
  let context;
  const errors = [];
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route =>
      new URL(route.request().url()).origin === hub.url ? route.continue() : route.abort(),
    );
    await page.route("**/api/config", route => route.fulfill(
      route.request().method() === "POST"
        ? { status: 500, json: { error: "Synthetic save failure" } }
        : { json: { runnerOptions: {}, selectedProjects: [] } },
    ));
    await page.goto(hub.url + "/runner");
    await expect(page.locator(".xterm")).toBeVisible();
    await page.locator("#opt-grep").fill("unsaved title");
    await expect(page.locator("#runner-save-status")).toContainText("Synthetic save failure");
    expect(errors).toEqual([]);
    const scripts = await page.locator("script[src]").evaluateAll(elements =>
      elements.map(element => element.src),
    );
    expect(scripts.every(source => source.startsWith(hub.url))).toBe(true);
  } finally {
    await context?.close();
    for (const dispose of cleanup.reverse()) await dispose();
  }
});

test("scan warnings stay visible and stale Delete confirmations retain the selected UUID", async ({ browser }) => {
  const cleanup = [];
  const hub = await startHub({ after: fn => cleanup.push(fn) }, "browser");
  let context;
  try {
    context = await browser.newContext();
    await context.route("**/*", route =>
      new URL(route.request().url()).origin === hub.url ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    fs.writeFileSync(path.join(hub.root, "scan-read-fail"), "");
    await page.goto(hub.url);
    await expect(page.locator("#report-warnings")).toContainText("Existing data was preserved");
    const row = page.locator('.report-row[data-path="/reports/current/fixture-report/index.html"]');
    await row.getByRole("button", { name: "More actions" }).click();
    await row.getByRole("button", { name: "Delete Report", exact: true }).click();
    await expect(page.locator("#delete-modal")).toBeVisible();
    fs.unlinkSync(path.join(hub.root, "scan-read-fail"));
    fs.writeFileSync(path.join(hub.root, "replaced-report"), "");
    await page.request.get(hub.url + "/api/reports");
    const deletion = page.waitForResponse("**/api/delete");
    await page.locator("#confirm-delete-btn").click();
    const response = await deletion;
    expect(response.request().postDataJSON().reportUuid).toBe("fixture-uuid");
    expect(response.status()).toBe(409);
    await expect(page.locator("#delete-modal-error")).toContainText("identity changed");
    expect(fs.existsSync(hub.reportRoot)).toBe(true);
  } finally {
    await context?.close();
    for (const dispose of cleanup.reverse()) await dispose();
  }
});
