const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { startHub } = require("./helpers/hub.cjs");

test("trace recovery is injected only into served viewer pages without changing report files", async t => {
  const hub = await startHub(t);
  const html = '<!doctype html><html><head><script type="module" src="viewer.js"></script></head><body>Viewer</body></html>';
  for (const scope of ["current", "archive"]) {
    const directory = path.join(hub.root, scope, "nested", "report", "trace");
    fs.mkdirSync(directory, { recursive: true });
    for (const name of ["index.html", "snapshot.html"])
      fs.writeFileSync(path.join(directory, name), html);
    fs.writeFileSync(path.join(directory, "sw.bundle.js"), "// original worker");
    const base = `${hub.url}/reports/${scope}/nested/report/trace/`;
    for (const suffix of ["index.html?trace=test.zip", ""]) {
      const response = await fetch(base + suffix);
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/html/);
      assert.match(body, /<head><script src="\.\/playwright-reports-trace-recovery\.js"><\/script>/);
      assert.ok(body.indexOf("playwright-reports-trace-recovery.js") < body.indexOf('type="module"'));
      assert.equal(fs.readFileSync(path.join(directory, "index.html"), "utf8"), html);
    }
    assert.equal(await (await fetch(base + "snapshot.html")).text(), html);
    assert.equal(await (await fetch(base + "sw.bundle.js")).text(), "// original worker");
    const helper = await fetch(base + "playwright-reports-trace-recovery.js");
    assert.equal(helper.status, 200);
    assert.match(helper.headers.get("content-type"), /javascript/);
    assert.match(helper.headers.get("cache-control"), /no-cache/);
    assert.match(await helper.text(), /serviceWorker/);
    const head = await fetch(base + "index.html", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  }
  assert.equal(
    await (await fetch(hub.url + "/reports/current/fixture-report/index.html")).text(),
    "<title>Playwright Test Report</title>",
  );
  assert.equal((await fetch(hub.url + "/reports/current/missing/trace/index.html")).status, 404);
  assert.equal((await fetch(hub.url + "/reports/current/%2e%2e%2foutside/trace/index.html")).status, 403);
});
