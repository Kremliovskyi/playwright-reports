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
]) {
  test(`${scenario} browser workflow`, async ({ browser }) => {
    const cleanup = [];
    const hub = await startHub({ after: fn => cleanup.push(fn) }, seed);
    let context;
    try {
      context = await browser.newContext();
      const page = await context.newPage();
      fs.mkdirSync(path.join(__dirname, "../.browser-results"), { recursive: true });
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        return url.origin === hub.url ? route.continue() : route.abort();
      });
      await page.goto(hub.url);
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
