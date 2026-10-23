const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { startHub } = require("./helpers/hub.cjs");
const { reportHtml, trendTest } = require("./trends-fixture.cjs");

for (const style of ["window", "script", "template"]) {
  test(`ARIA extraction and application preserve ${style} report input`, async t => {
    const hub = await startHub(t);
    const project = path.join(hub.root, "project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "playwright.config.ts"), `
      export default { expect: { toMatchAriaSnapshot: { pathTemplate: "snapshots/{testFilePath}/{arg}{ext}" } } };
    `);
    assert.equal((await hub.request("/api/config", { projectPath: project })).status, 200);
    const snapshotPath = "snapshots/tests/order.spec.ts/expected.yml";
    const absoluteSnapshot = path.join(project, snapshotPath);
    fs.mkdirSync(path.dirname(absoluteSnapshot), { recursive: true });
    fs.writeFileSync(absoluteSnapshot, '- heading "Before"');
    const html = reportHtml([trendTest({
      results: [{
        retry: 0, duration: 120000, status: "failed",
        errors: [{
          message: `Error: expect(locator).toMatchAriaSnapshot({ name: 'expected.yml' }) failed\n@@ -1 +1 @@\n-- heading "Before"\n+- heading "After"\nCall log:`,
        }],
      }],
    })], { style });
    const index = path.join(hub.reportRoot, "index.html");
    fs.writeFileSync(index, html);
    const extracted = await hub.request("/api/aria-snapshots", { reportPath: "/reports/current/fixture-report/index.html" });
    assert.equal(extracted.status, 200);
    const snapshot = extracted.data.ariaFailures[0].snapshots[0];
    assert.equal(snapshot.expectedPath.split(path.sep).join("/"), snapshotPath);
    assert.equal(snapshot.expectedSnapshot, '- heading "Before"');
    assert.equal(snapshot.newSnapshot, '- heading "After"');
    const newContent = "- /children: deep-equal\n" + snapshot.newSnapshot;
    assert.equal((await hub.request("/api/fix-aria-snapshot", { snapshotPath, newContent })).status, 200);
    assert.equal(fs.readFileSync(absoluteSnapshot, "utf8"), newContent);
    assert.equal(fs.readFileSync(index, "utf8"), html);
  });
}

test("ARIA rejects unresolved paths and invalid input without creating files", async t => {
  const hub = await startHub(t);
  await hub.request("/api/config", { projectPath: hub.root });
  for (const body of [
    { snapshotPath: "UNRESOLVED_PATH.yml", newContent: "wrong file" },
    { snapshotPath: "invalid.yml", newContent: {} },
  ])
    assert.equal((await hub.request("/api/fix-aria-snapshot", body)).status, 400);
  assert.ok(!fs.existsSync(path.join(hub.root, "UNRESOLVED_PATH.yml")));
  assert.ok(!fs.existsSync(path.join(hub.root, "invalid.yml")));
});

test("ARIA config evaluation errors do not silently fall back to guessed paths", async t => {
  const hub = await startHub(t);
  fs.writeFileSync(path.join(hub.root, "playwright.config.ts"), 'throw new Error("broken fixture config");');
  await hub.request("/api/config", { projectPath: hub.root });
  const response = await hub.request("/api/aria-snapshots", { reportPath: "/reports/current/fixture-report/index.html" });
  assert.equal(response.status, 400);
  assert.match(response.data.error, /broken fixture config/);
});

test("ARIA uses the full call-log snapshot instead of a truncated diff", async t => {
  const hub = await startHub(t);
  await hub.request("/api/config", { projectPath: hub.root });
  const message = `Error: expect(locator).toMatchAriaSnapshot({ name: 'full.yml' }) failed
@@ -1 +1 @@
-- heading "Before"
+- heading "After"
Call log:
  - unexpected value "- heading "After"
    - paragraph "Full omitted middle"
    - button "Done""
`;
  fs.writeFileSync(path.join(hub.reportRoot, "index.html"), reportHtml([
    trendTest({ results: [{ retry: 0, duration: 120000, status: "failed", errors: [{ message }] }] }),
  ]));
  const response = await hub.request("/api/aria-snapshots", { reportPath: "/reports/current/fixture-report/index.html" });
  assert.equal(response.status, 200);
  const snapshot = response.data.ariaFailures[0].snapshots[0].newSnapshot;
  assert.match(snapshot, /Full omitted middle/);
  assert.match(snapshot, /button "Done"/);
});
