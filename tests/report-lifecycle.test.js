const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { startHub } = require("./helpers/hub.cjs");

test("scan read failures preserve catalog identity, metadata and analysis until recovery", async t => {
  const hub = await startHub(t, "browser");
  const before = await hub.request("/api/report-info?reportId=fixture-report", undefined, "GET");
  fs.writeFileSync(path.join(hub.root, "scan-read-fail"), "");
  const scan = await hub.request("/api/reports", undefined, "GET");
  assert.equal(scan.status, 200);
  assert.ok(scan.data.warnings.some(warning => warning.code === "REPORT_SCAN_FAILED"));
  assert.equal(scan.data.current.find(report => report.id === "fixture-report").uuid, "fixture-uuid");
  const after = await hub.request("/api/report-info?reportId=fixture-report", undefined, "GET");
  assert.deepEqual(after.data.runs, before.data.runs);
  assert.ok(fs.existsSync(before.data.runs[0].runDir));
  fs.unlinkSync(path.join(hub.root, "scan-read-fail"));
  const recovered = await hub.request("/api/reports", undefined, "GET");
  assert.deepEqual(recovered.data.warnings, []);
  assert.equal(recovered.data.current.find(report => report.id === "fixture-report").uuid, "fixture-uuid");
});

test("incomplete report HTML is not mistaken for a deleted report", async t => {
  const hub = await startHub(t, "browser");
  fs.writeFileSync(path.join(hub.reportRoot, "index.html"), "");
  const scan = await hub.request("/api/reports", undefined, "GET");
  assert.equal(scan.data.current.find(report => report.id === "fixture-report").uuid, "fixture-uuid");
  assert.ok(scan.data.warnings.length);
  assert.equal((await hub.request("/api/report-info?reportId=fixture-report", undefined, "GET")).data.runs.length, 1);
});

test("cross-scope basename collisions preserve the indexed report and its artifacts", async t => {
  const hub = await startHub(t, "browser");
  const duplicate = path.join(hub.root, "archive", "fixture-report");
  fs.mkdirSync(duplicate);
  fs.writeFileSync(path.join(duplicate, "index.html"), "<title>Playwright Test Report</title>");
  for (let index = 0; index < 2; index++) {
    const scan = await hub.request("/api/reports", undefined, "GET");
    assert.ok(scan.data.warnings.some(warning => warning.code === "REPORT_NAME_CONFLICT"));
    assert.equal(scan.data.current.find(report => report.id === "fixture-report").uuid, "fixture-uuid");
    assert.ok(!scan.data.archive.some(report => report.id === "fixture-report"));
    assert.equal((await hub.request("/api/report-info?reportId=fixture-report", undefined, "GET")).data.runs.length, 1);
  }
  const mutation = await hub.request("/api/delete", {
    reportPath: "/reports/archive/fixture-report/index.html",
    reportUuid: "fixture-uuid",
  });
  assert.equal(mutation.status, 409);
  assert.ok(fs.existsSync(duplicate));
  assert.ok(fs.existsSync(hub.reportRoot));
});

test("stale report mutations reject replacement instances before and after a scan", async t => {
  const hub = await startHub(t);
  const reportPath = "/reports/current/fixture-report/index.html";
  fs.writeFileSync(path.join(hub.root, "replaced-report"), "");
  for (const [endpoint, body] of [
    ["/api/delete", { reportPath }],
    ["/api/archive", { reportPath }],
    ["/api/extract", { reportPath }],
    ["/api/report-metadata", { reportId: "fixture-report", metadata: "wrong instance" }],
  ]) {
    assert.equal((await hub.request(endpoint, { ...body, reportUuid: "fixture-uuid" })).status, 409);
    assert.ok(fs.existsSync(hub.reportRoot));
  }
  await hub.request("/api/reports", undefined, "GET");
  const afterScan = await hub.request("/api/delete", { reportPath, reportUuid: "fixture-uuid" });
  assert.equal(afterScan.status, 409);
  assert.ok(fs.existsSync(hub.reportRoot));
});

test("confirmed missing folders still prune orphaned artifacts", async t => {
  const hub = await startHub(t, "browser");
  const before = await hub.request("/api/report-info?reportId=fixture-report", undefined, "GET");
  fs.renameSync(hub.reportRoot, path.join(hub.root, "removed-report"));
  await hub.request("/api/reports", undefined, "GET");
  assert.equal((await hub.request("/api/report-info?reportId=fixture-report", undefined, "GET")).status, 404);
  assert.ok(!fs.existsSync(before.data.runs[0].runDir));
  const db = new Database(hub.databasePath, { readonly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS count FROM analysis_runs WHERE reportId = ?").get("fixture-uuid").count, 0); }
  finally { db.close(); }
});
