const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const AdmZip = require("adm-zip");
const { startHub } = require("./helpers/hub.cjs");

function writeArchives(reportRoot) {
  for (const name of ["first", "second"]) {
    const zip = new AdmZip();
    zip.addFile("test.trace", Buffer.from(name + "\n"));
    zip.addFile("resources/body.txt", Buffer.from("body " + name));
    zip.writeZip(path.join(reportRoot, "data", name + ".zip"));
  }
}

function events(child, t) {
  const seen = [];
  const pending = new Set();
  const listener = event => {
    seen.push(event);
    for (const request of pending) {
      if (request.predicate(event)) {
        pending.delete(request);
        clearTimeout(request.timer);
        request.resolve(event);
      }
    }
  };
  child.on("message", listener);
  t.after(() => {
    child.removeListener("message", listener);
    for (const request of pending) clearTimeout(request.timer);
  });
  return {
    seen,
    wait: predicate => {
      const existing = seen.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const request = { predicate, resolve, timer: setTimeout(() => {
          pending.delete(request);
          reject(new Error("Timed out waiting for preparation event"));
        }, 5000) };
        pending.add(request);
      });
    },
  };
}

async function addArchive(hub) {
  const root = path.join(hub.root, "archive", "archived-fixture");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<title>Playwright Test Report</title>");
  writeArchives(root);
  const scan = await hub.request("/api/reports", undefined, "GET");
  const report = scan.data.archive.find(report => report.id === "archived-fixture");
  assert.ok(report);
  return { root, target: { reportPath: report.path, reportUuid: report.uuid } };
}

test("Extract works for current and archived reports, preserves ZIPs, and remains idempotent", async t => {
  const hub = await startHub(t);
  writeArchives(hub.reportRoot);
  const archive = await addArchive(hub);
  for (const [root, target] of [
    [hub.reportRoot, { reportPath: "/reports/current/fixture-report/index.html", reportUuid: "fixture-uuid" }],
    [archive.root, archive.target],
  ]) {
    const zip = fs.readFileSync(path.join(root, "data", "first.zip"));
    const first = await hub.request("/api/extract", target);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.extractedCount, 2);
    assert.equal(fs.readFileSync(path.join(root, "data", "first", "test.trace"), "utf8"), "first\n");
    assert.deepEqual(fs.readFileSync(path.join(root, "data", "first.zip")), zip);
    assert.equal((await hub.request("/api/extract", target)).data.extractedCount, 0);
    assert.ok(!fs.readdirSync(path.join(root, "data")).some(name => name.startsWith(".extract-")));
  }
});

test("active extraction keeps the server responsive and blocks conflicting report operations", async t => {
  const hub = await startHub(t, "", { ARTIFACT_TEST_PREPARATION_EVENTS: "1" });
  writeArchives(hub.reportRoot);
  const recorded = events(hub.child, t);
  fs.writeFileSync(path.join(hub.root, "hold-extraction"), "");
  const target = { reportPath: "/reports/current/fixture-report/index.html", reportUuid: "fixture-uuid" };
  const extracting = hub.request("/api/extract", target);
  await recorded.wait(event => event.event === "extraction-held");
  assert.equal((await hub.request("/api/reports", undefined, "GET")).status, 200);
  for (const [endpoint, body] of [
    ["/api/extract", target],
    ["/api/archive", target],
    ["/api/delete", target],
    ["/api/report-rename", { ...target, newName: "unsafe" }],
    ["/api/failures", target],
    ["/api/digest-test", { ...target, tracePath: path.join(hub.reportRoot, "data", "first.zip") }],
  ]) {
    const response = await hub.request(endpoint, body);
    assert.equal(response.status, 409, endpoint);
    assert.equal(response.data.code, "REPORT_ARTIFACTS_BUSY", endpoint);
  }
  assert.equal((await hub.request("/api/config", { currentPath: hub.root })).status, 409);
  assert.equal(fs.existsSync(path.join(hub.reportRoot, "data", "first")), false);
  fs.unlinkSync(path.join(hub.root, "hold-extraction"));
  hub.child.send({ resumeExtraction: true });
  assert.equal((await extracting).status, 200);
  const progress = recorded.seen.filter(event => event.event === "trace-extraction" && event.phase === "progress");
  assert.deepEqual(progress.map(event => event.completed), [0, 1, 2]);
  assert.ok(progress.every(event => event.reportUuid === "fixture-uuid"));
  assert.equal((await hub.request("/api/extract", target)).status, 200);
});

test("Analyze Failures and Extract share a queue, but AI does not hold its preparation slot", async t => {
  const hub = await startHub(t, "", { ARTIFACT_TEST_PREPARATION_EVENTS: "1" });
  const archive = await addArchive(hub);
  const recorded = events(hub.child, t);
  fs.writeFileSync(path.join(hub.root, "hold-command"), "");
  fs.writeFileSync(path.join(hub.root, "hold-ai"), "");
  const analyzing = hub.request("/api/failures", { reportPath: "/reports/current/fixture-report/index.html" });
  await recorded.wait(event => event.event === "command-started");
  const extracting = hub.request("/api/extract", archive.target);
  await recorded.wait(event => event.event === "trace-extraction" && event.phase === "queued");
  assert.ok(!recorded.seen.some(event => event.event === "extraction-worker-started"));
  assert.equal((await hub.request("/api/delete", archive.target)).status, 409);
  fs.unlinkSync(path.join(hub.root, "hold-command"));
  hub.child.send({ resume: true });
  await recorded.wait(event => event.event === "ai-started");
  assert.equal((await extracting).status, 200);
  assert.ok(fs.existsSync(path.join(hub.root, "hold-ai")));
  fs.unlinkSync(path.join(hub.root, "hold-ai"));
  hub.child.send({ resumeAi: true });
  assert.equal((await analyzing).status, 200);
  const args = JSON.parse(fs.readFileSync(path.join(hub.root, "command-args.jsonl"), "utf8").trim());
  assert.equal(args[args.indexOf("--workers") + 1], "4");
  assert.ok(recorded.seen.filter(event => event.event === "failure-analysis").every(event => event.reportUuid === "fixture-uuid"));
});

test("failed extraction releases both its report lock and the preparation queue", async t => {
  const hub = await startHub(t);
  const target = { reportPath: "/reports/current/fixture-report/index.html" };
  const failed = await hub.request("/api/extract", target);
  assert.equal(failed.status, 500);
  assert.match(failed.data.error, /Failed to extract/);
  assert.ok(!fs.readdirSync(path.join(hub.reportRoot, "data")).some(name => name.startsWith(".extract-")));
  writeArchives(hub.reportRoot);
  const retry = await hub.request("/api/extract", target);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.extractedCount, 2);
  assert.equal((await hub.request("/api/failures", target)).status, 200);
});

test("queued failure preparation waits for extraction and rechecks the report identity before starting", async t => {
  const hub = await startHub(t, "", { ARTIFACT_TEST_PREPARATION_EVENTS: "1" });
  const archive = await addArchive(hub);
  const recorded = events(hub.child, t);
  fs.writeFileSync(path.join(hub.root, "hold-extraction"), "");
  const extracting = hub.request("/api/extract", archive.target);
  await recorded.wait(event => event.event === "extraction-held");
  const analyzing = hub.request("/api/failures", { reportPath: "/reports/current/fixture-report/index.html" });
  await recorded.wait(event => event.event === "failure-analysis" && event.phase === "queued");
  assert.equal(fs.existsSync(path.join(hub.root, "command-args.jsonl")), false);
  assert.equal((await hub.request("/api/delete", { reportPath: "/reports/current/fixture-report/index.html" })).status, 409);
  fs.writeFileSync(path.join(hub.root, "replaced-report"), "");
  fs.unlinkSync(path.join(hub.root, "hold-extraction"));
  hub.child.send({ resumeExtraction: true });
  assert.equal((await extracting).status, 200);
  const response = await analyzing;
  assert.equal(response.status, 409);
  assert.equal(response.data.code, "REPORT_CHANGED");
  assert.equal(fs.existsSync(path.join(hub.root, "command-args.jsonl")), false);
  assert.equal(fs.existsSync(path.join(hub.root, "current", "tmp", "analysis-fixture-uuid")), false);
});

test("Analyze Failures integrates the installed reader with real failed retries and no AI calls", async t => {
  const hub = await startHub(t, "", {
    ARTIFACT_TEST_REAL_READER: "1",
    ARTIFACT_TEST_PREPARATION_EVENTS: "1",
  });
  const recorded = events(hub.child, t);
  const data = path.join(hub.reportRoot, "data");
  for (const name of ["first.zip", "second.zip"]) fs.unlinkSync(path.join(data, name));
  const results = [];
  for (const [index, status] of ["failed", "timedOut", "passed"].entries()) {
    const name = `attempt-${index}`;
    if (status === "passed") fs.writeFileSync(path.join(data, `${name}.zip`), "must not be opened");
    else {
      const zip = new AdmZip();
      zip.addFile("test.trace", Buffer.from([
        { type: "before", callId: "test", apiName: "test.step", startTime: 0, title: "Test failure" },
        { type: "after", callId: "test", endTime: 1, error: { message: "Synthetic failure" } },
      ].map(value => JSON.stringify(value)).join("\n") + "\n"));
      zip.writeZip(path.join(data, `${name}.zip`));
    }
    results.push({ status, attachments: [{ name: "trace", path: `data/${name}.zip`, contentType: "application/zip" }] });
  }
  const report = new AdmZip();
  report.addFile("report.json", Buffer.from(JSON.stringify({
    files: [{ fileId: "spec", tests: [{
      testId: "flaky-test", title: "Flaky test", outcome: "flaky", ok: true, results,
    }] }],
  })));
  fs.writeFileSync(path.join(hub.reportRoot, "index.html"),
    `<title>Playwright Test Report</title><template id="playwrightReportBase64">data:application/zip;base64,${report.toBuffer().toString("base64")}</template>`);
  const response = await hub.request("/api/failures", { reportPath: "/reports/current/fixture-report/index.html" });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.count, 2);
  assert.deepEqual(response.data.manifest.failures.map(entry => entry.retryIndex), [0, 1]);
  for (const entry of response.data.manifest.failures)
    assert.ok(fs.existsSync(path.join(response.data.runDir, entry.folder, "failure.json")));
  assert.equal(recorded.seen.find(event => event.event === "ai-started").count, 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(response.data.runDir, "index.json"), "utf8"));
  assert.equal(manifest.runDir, response.data.runDir);
  assert.equal(fs.existsSync(path.join(data, "attempt-0")), false);
});
