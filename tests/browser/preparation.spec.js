const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const AdmZip = require("adm-zip");
const { startHub } = require("../helpers/hub.cjs");

for (const action of ["Extract Traces", "Analyze Failures"]) {
  test(`queued ${action} progress stays scoped to its report`, async ({ browser }) => {
    const cleanup = [];
    const hub = await startHub({ after: fn => cleanup.push(fn) }, "", {
      ARTIFACT_TEST_PREPARATION_EVENTS: "1",
    });
    const events = [];
    hub.child.on("message", event => events.push(event));
    let context;
    try {
      const scope = action === "Extract Traces" ? "archive" : "current";
      const secondRoot = path.join(hub.root, scope, "second-report");
      fs.mkdirSync(path.join(secondRoot, "data"), { recursive: true });
      fs.writeFileSync(path.join(secondRoot, "index.html"), "<title>Playwright Test Report</title>");
      const zip = new AdmZip();
      zip.addFile("test.trace", Buffer.from("synthetic trace"));
      zip.writeZip(path.join(secondRoot, "data", "trace.zip"));
      fs.writeFileSync(path.join(hub.root, "hold-command"), "");
      fs.writeFileSync(path.join(hub.root, "hold-ai"), "");
      context = await browser.newContext();
      await context.route("**/*", route =>
        new URL(route.request().url()).origin === hub.url ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      const errors = [];
      const progressRequests = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/logs") progressRequests.push(request);
      });
      await page.goto(hub.url);
      const first = page.locator('.report-row[data-path="/reports/current/fixture-report/index.html"]');
      const second = page.locator(`.report-row[data-path="/reports/${scope}/second-report/index.html"]`);
      await first.getByRole("button", { name: "More actions" }).click();
      await first.getByRole("button", { name: "Analyze Failures", exact: true }).click();
      await expect.poll(() => events.some(event => event.event === "command-started")).toBe(true);
      await expect(first.locator(".row-progress-text")).toHaveText("Digesting failures...");
      await second.getByRole("button", { name: "More actions" }).click();
      const button = second.getByRole("button", { name: action, exact: true });
      await button.click();
      await expect(second.locator(".row-progress-text")).toHaveText("Waiting for preparation slot...");
      await expect(first.locator(".row-progress-text")).toHaveText("Digesting failures...");
      expect(progressRequests).toHaveLength(1);
      const queued = events.filter(event => event.phase === "queued").length;
      await second.locator(action === "Extract Traces" ? ".overflow-extract" : ".overflow-failures")
        .evaluate(element => element.click());
      await expect(second.locator(".row-progress-text")).toHaveText("Waiting for preparation slot...");
      expect(events.filter(event => event.phase === "queued")).toHaveLength(queued);
      fs.unlinkSync(path.join(hub.root, "hold-command"));
      hub.child.send({ resume: true });
      if (action === "Extract Traces") {
        await expect(second.locator(".row-progress-text")).toHaveText("Extracted");
        expect(fs.readFileSync(path.join(secondRoot, "data", "trace", "test.trace"), "utf8")).toBe("synthetic trace");
      } else {
        await expect.poll(() => events.filter(event => event.event === "ai-started").length).toBe(2);
        await expect(second.locator(".row-progress-text")).toHaveText("Analyzing...");
      }
      await expect(first.locator(".row-progress-text")).toHaveText("Analyzing...");
      fs.unlinkSync(path.join(hub.root, "hold-ai"));
      hub.child.send({ resumeAi: true });
      await expect(page.locator("#failures-modal")).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      try {
        for (const dispose of cleanup.reverse()) await dispose();
      } finally {
        await context?.close();
      }
    }
  });

  for (const unavailable of ["error", "timeout"]) {
    test(`${action} completes despite a progress connection ${unavailable}`, async ({ browser }) => {
      const cleanup = [];
      const hub = await startHub({ after: fn => cleanup.push(fn) });
      let context;
      let releaseProgress;
      const progressGate = new Promise(resolve => { releaseProgress = resolve; });
      try {
        if (action === "Extract Traces") {
          for (const name of ["first", "second"]) {
            const zip = new AdmZip();
            zip.addFile("test.trace", Buffer.from(name));
            zip.writeZip(path.join(hub.reportRoot, "data", `${name}.zip`));
          }
        }
        context = await browser.newContext();
        await context.route("**/*", async route => {
          const url = new URL(route.request().url());
          if (url.origin !== hub.url) return route.abort();
          if (url.pathname === "/api/logs") {
            if (unavailable === "timeout") await progressGate;
            return route.abort();
          }
          return route.continue();
        });
        const page = await context.newPage();
        const warnings = [];
        page.on("console", message => {
          if (message.type() === "warning") warnings.push(message.text());
        });
        await page.goto(hub.url);
        const row = page.locator('.report-row[data-path="/reports/current/fixture-report/index.html"]');
        await row.getByRole("button", { name: "More actions" }).click();
        await row.getByRole("button", { name: action, exact: true }).click();
        if (action === "Extract Traces") {
          await expect(row.locator(".row-progress-text")).toHaveText("Extracted");
          for (const name of ["first", "second"])
            expect(fs.readFileSync(path.join(hub.reportRoot, "data", name, "test.trace"), "utf8"))
              .toBe(name);
        } else {
          await expect(page.locator("#failures-modal")).toBeVisible();
        }
        expect(warnings).toContain("Live progress is unavailable; continuing the report operation.");
      } finally {
        releaseProgress();
        try {
          for (const dispose of cleanup.reverse()) await dispose();
        } finally {
          await context?.close();
        }
      }
    });
  }
}
