const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { startHub } = require("../helpers/hub.cjs");

// The real-viewer regression records its own trace rather than the runner's test trace.
test.use({ trace: "off" });
test.setTimeout(30_000);

const versionError = "The trace was created by a newer version of Playwright and is not supported by this version of the viewer. Please use latest Playwright to open the trace.";
const installGate = `
self.addEventListener("install", event => event.waitUntil(new Promise(resolve => {
  self.addEventListener("message", message => {
    if (message.data === "finish-install") resolve();
  });
})));
`;

function workerSource(name, error = versionError, gate = false) {
  return `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (new URL(event.request.url).pathname.endsWith("/contexts")) {
    event.respondWith(Promise.resolve(new Response(
      ${JSON.stringify(JSON.stringify(error ? { error } : [{ title: name }]))},
      { status: ${error ? 500 : 200}, headers: { "Content-Type": "application/json" } }
    )));
  } else {
    event.respondWith(fetch(event.request));
  }
});
// ${name}
${gate ? installGate : ""}
`;
}

const viewerHtml = `<!doctype html><html><head><title>Playwright Trace Viewer</title></head>
<body><main></main><script>
window.loadTrace = async () => {
  const response = await fetch("contexts?trace=test.zip");
  window.traceResponse = { status: response.status, body: await response.json() };
  document.querySelector("main").textContent = JSON.stringify(window.traceResponse.body);
};
navigator.serviceWorker.register("sw.bundle.js");
</script></body></html>`;

async function fixture(browser, run) {
  const cleanup = [];
  const hub = await startHub({ after: fn => cleanup.push(fn) });
  let context;
  try {
    context = await browser.newContext();
    const directory = path.join(hub.reportRoot, "trace");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "index.html"), viewerHtml);
    fs.writeFileSync(path.join(directory, "sw.bundle.js"), workerSource("original"));
    const page = await context.newPage();
    const diagnostics = [];
    const errors = [];
    let contextRequests = 0;
    page.on("console", message => {
      if (message.text().startsWith("[trace-viewer-recovery]"))
        diagnostics.push(message.text());
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (new URL(request.url()).pathname.endsWith("/contexts")) contextRequests++;
    });
    const url = hub.url + "/reports/current/fixture-report/trace/index.html";
    await page.goto(url);
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated");
    await page.evaluate(() => { window.originalController = navigator.serviceWorker.controller; });
    await run({
      hub, context, page, directory, url, diagnostics, errors,
      requests: () => contextRequests,
      replaceWorker: source => fs.writeFileSync(path.join(directory, "sw.bundle.js"), source),
    });
    expect(errors).toEqual([]);
  } finally {
    try {
      await context?.close();
    } finally {
      for (const dispose of cleanup.reverse()) await dispose();
    }
  }
}

async function finishInstall(page) {
  await expect.poll(() => page.evaluate(async () => {
    const installing = (await navigator.serviceWorker.getRegistration())?.installing;
    if (!installing) return false;
    installing.postMessage("finish-install");
    return true;
  })).toBe(true);
}

for (const alreadyInstalling of [false, true]) {
  test(`trace viewer recovers without touching archived tabs (${alreadyInstalling ? "update already installing" : "new update"})`, async ({ browser }) => {
    await fixture(browser, async ({ hub, context, page, replaceWorker, requests, diagnostics }) => {
      const archive = path.join(hub.root, "archive", "old-report", "trace");
      fs.mkdirSync(archive, { recursive: true });
      fs.writeFileSync(path.join(archive, "index.html"), viewerHtml);
      fs.writeFileSync(path.join(archive, "sw.bundle.js"), workerSource("archived"));
      const archivedPage = await context.newPage();
      await archivedPage.goto(hub.url + "/reports/archive/old-report/trace/index.html");
      await archivedPage.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated");
      await archivedPage.evaluate(() => { window.originalController = navigator.serviceWorker.controller; });

      replaceWorker(workerSource("replacement", null, true));
      if (alreadyInstalling) {
        await page.evaluate(async () => {
          void (await navigator.serviceWorker.getRegistration()).update();
        });
        await expect.poll(() => page.evaluate(async () =>
          Boolean((await navigator.serviceWorker.getRegistration())?.installing),
        )).toBe(true);
      }
      await page.evaluate(() => {
        window.recoveryUpdateCalls = 0;
        const update = ServiceWorkerRegistration.prototype.update;
        ServiceWorkerRegistration.prototype.update = function () {
          window.recoveryUpdateCalls++;
          return update.call(this);
        };
      });
      await page.evaluate(() => { void window.loadTrace(); });
      await expect(page.getByRole("status")).toContainText("Checking for an updated");
      expect(requests()).toBe(1);
      await finishInstall(page);
      await expect(page.locator("main")).toHaveText('[{"title":"replacement"}]');
      expect(await page.evaluate(() => window.traceResponse.status)).toBe(200);
      expect(requests()).toBe(2);
      expect(await page.evaluate(() => window.recoveryUpdateCalls)).toBe(alreadyInstalling ? 0 : 1);
      expect(diagnostics.some(message => message.includes("recovered"))).toBe(true);
      expect(await archivedPage.evaluate(() =>
        navigator.serviceWorker.controller === window.originalController,
      )).toBe(true);
      expect(await page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).length,
      )).toBe(2);
      await page.evaluate(() => window.loadTrace());
      expect(requests()).toBe(3);
    });
  });
}

for (const scenario of ["no update", "still incompatible", "update failure", "install timeout", "unrelated error"]) {
  test(`trace viewer preserves the original error with ${scenario}`, async ({ browser }) => {
    await fixture(browser, async ({ page, replaceWorker, requests, diagnostics }) => {
      let originalError = versionError;
      if (scenario === "unrelated error") {
        originalError = "Could not load trace. Make sure a valid Playwright Trace is accessible.";
        replaceWorker(workerSource("unrelated-error", originalError));
        await page.evaluate(async () => {
          const previous = navigator.serviceWorker.controller;
          await (await navigator.serviceWorker.getRegistration()).update();
          if (navigator.serviceWorker.controller !== previous) return;
          await new Promise(resolve =>
            navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }),
          );
        });
        replaceWorker(workerSource("unused-replacement", null));
      } else if (scenario === "still incompatible") {
        replaceWorker(workerSource("still-incompatible", "Replacement: " + versionError));
      } else if (scenario === "update failure") {
        replaceWorker("this is deliberately invalid worker JavaScript !!!");
      } else if (scenario === "install timeout") {
        replaceWorker(workerSource("blocked-installation", null, true));
      }
      const started = Date.now();
      await page.evaluate(() => { void window.loadTrace(); });
      await expect(page.locator("main")).toHaveText(JSON.stringify({ error: originalError }));
      expect(await page.evaluate(() => window.traceResponse.status)).toBe(500);
      const expectedRequests = scenario === "still incompatible" ? 2 : 1;
      expect(requests()).toBe(expectedRequests);
      if (scenario === "install timeout") {
        expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
        expect(Date.now() - started).toBeLessThan(8000);
        await finishInstall(page);
        await expect.poll(() => page.evaluate(() =>
          navigator.serviceWorker.controller !== window.originalController &&
          navigator.serviceWorker.controller?.state === "activated",
        )).toBe(true);
        expect(requests()).toBe(1);
      } else {
        await page.evaluate(() => window.loadTrace());
        expect(requests()).toBe(expectedRequests + 1);
      }
      if (scenario === "unrelated error") {
        expect(diagnostics).toEqual([]);
        await expect(page.getByRole("status")).toHaveCount(0);
      } else {
        expect(diagnostics.length).toBeGreaterThan(0);
        await expect(page.getByRole("status")).toContainText("original error");
      }
    });
  });
}

test.describe("real trace integration", () => {
  test("recovery works with the installed Playwright viewer and a real trace", async ({ browser }) => {
    await fixture(browser, async ({ hub, page, directory, url, requests }) => {
      const trace = path.join(hub.reportRoot, "data", "real-trace.zip");
      const recording = await browser.newContext();
      try {
        await recording.tracing.start({ snapshots: true, screenshots: true });
        const recordedPage = await recording.newPage();
        await recordedPage.setContent("<h1>Trace recovery fixture</h1>");
        await recordedPage.getByRole("heading").click();
        await recording.tracing.stop({ path: trace });
      } finally {
        await recording.close();
      }
      const viewer = path.join(path.dirname(require.resolve("playwright-core/package.json")), "lib/vite/traceViewer");
      fs.cpSync(viewer, directory, { recursive: true });
      fs.appendFileSync(path.join(directory, "sw.bundle.js"), installGate);
      const traceUrl = hub.url + "/reports/current/fixture-report/data/real-trace.zip";
      await page.goto(url + "?trace=" + encodeURIComponent(traceUrl));
      await expect(page.getByRole("status")).toContainText("Checking for an updated");
      const [loaded] = await Promise.all([
        page.waitForResponse(response =>
          new URL(response.url()).pathname.endsWith("/contexts") && response.ok(),
        ),
        finishInstall(page),
      ]);
      expect((await loaded.json()).length).toBeGreaterThan(0);
      await expect(page.locator(".action-title-method").first()).toBeVisible();
      await expect(page.locator(".drop-target")).toHaveCount(0);
      expect(requests()).toBe(2);
    });
  });
});
