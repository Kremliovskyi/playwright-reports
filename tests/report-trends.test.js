const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseTrendReport,
  mergeTrendSeries,
  readTrendSource,
} = require("../dist/report-trends");
const { trendTest, reportHtml } = require("./trends-fixture.cjs");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const modelContext = vm.createContext({});
vm.runInContext(
  fs.readFileSync(
    path.join(__dirname, "../dist/public/trends-model.js"),
    "utf8",
  ),
  modelContext,
);
const model = modelContext.TrendModel;

const descriptor = (uuid = "report-1") => ({
  uuid,
  name: uuid,
  metadata: "DEV NA",
  createdAt: "2026-06-02T00:00:00.000Z",
  timestamp: "",
  timeSource: "catalog",
  version: "",
  scope: "current",
});

for (const style of ["window", "script", "template"]) {
  test(`reads ${style} embedded details without traces or disk extraction`, () => {
    const report = descriptor();
    const [series] = parseTrendReport(reportHtml(undefined, { style }), report);
    assert.equal(series.observations[0].passed, 120000);
    assert.equal(report.timestamp, "2026-06-01T07:00:00.000Z");
    assert.equal(report.timeSource, "report");
    assert.match(report.version, /^[a-f0-9]{64}$/);
  });
}

test("separates failed retries, actual passes, expected failures, skipped and zero duration", () => {
  const attempts = [
    { retry: 0, duration: 258000, status: "failed" },
    { retry: 1, duration: 234000, status: "failed" },
  ];
  const parse = (overrides) =>
    parseTrendReport(reportHtml([trendTest(overrides)]), descriptor())[0]
      .observations[0];
  const failed = parse({
    duration: 492000,
    results: attempts,
    outcome: "unexpected",
  });
  assert.equal(failed.total, 492000);
  assert.equal(failed.passed, null);
  assert.equal(
    parse({ duration: 492000, results: attempts, outcome: "expected" }).passed,
    null,
  );
  const flaky = parse({
    duration: 492000,
    results: [attempts[0], { ...attempts[1], status: "passed" }],
    outcome: "flaky",
  });
  assert.equal(flaky.passed, 234000);
  assert.equal(flaky.total, 492000);
  assert.equal(flaky.attempts[1].index, 1);
  assert.equal(
    parse({
      duration: 0,
      results: [{ retry: 0, duration: 0, status: "skipped" }],
      outcome: "skipped",
    }).total,
    null,
  );
  assert.equal(
    parse({
      duration: 0,
      results: [{ retry: 0, duration: 0, status: "passed" }],
    }).passed,
    0,
  );
});

test("matches stable titles across dated suites but separates environment, project, parameters and repeats", () => {
  const first = parseTrendReport(reportHtml(), descriptor());
  const later = parseTrendReport(
    reportHtml([
      trendTest({ testId: "different-hash", path: ["Orders [DEV NA - 6/2]"] }),
    ]),
    descriptor("report-2"),
  );
  assert.equal(mergeTrendSeries([...first, ...later]).length, 1);
  for (const overrides of [
    { projectName: "other" },
    { path: ["Orders [UAT NA - 6/2]"] },
    { title: "e2eExampleTC01 - parameter 2" },
    { repeatEachIndex: 1 },
    { location: { file: "other.spec.ts" } },
  ]) {
    const different = parseTrendReport(
      reportHtml([trendTest(overrides)]),
      descriptor("report-2"),
    );
    assert.equal(mergeTrendSeries([...first, ...different]).length, 2);
  }
  const collisions = parseTrendReport(
    reportHtml([
      trendTest(),
      trendTest({ testId: "second", path: ["Orders [DEV NA - 6/2]"] }),
    ]),
    descriptor(),
  );
  assert.ok(
    mergeTrendSeries([...collisions, ...later]).every(
      (series) => series.ambiguous,
    ),
  );
  const absolute = ["/first/order.spec.ts", "/second/order.spec.ts"].flatMap(
    (file, index) =>
      parseTrendReport(
        reportHtml([trendTest({ location: { file } })]),
        descriptor(`absolute-${index}`),
      ),
  );
  assert.equal(mergeTrendSeries(absolute).length, 2);
});

test("source reads reject traversal, symlinks and recycled folder instances", async (context) => {
  const root = fs.mkdtempSync(path.join(__dirname, ".trends-source-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "report");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "index.html"), reportHtml());
  const record = {
    dateCreated: fs.statSync(directory).birthtime.toISOString(),
  };
  assert.ok(
    (await readTrendSource(root, "report", record)).includes(
      "Playwright Test Report",
    ),
  );
  await assert.rejects(readTrendSource(root, "../outside", record), /outside/);
  fs.symlinkSync(directory, path.join(root, "link"), "dir");
  await assert.rejects(readTrendSource(root, "link", record), /Symbolic links/);
  await assert.rejects(
    readTrendSource(root, "report", {
      dateCreated: "2000-01-01T00:00:00.000Z",
    }),
    /replaced/,
  );
});

test("uses explicit timestamp fallbacks and rejects incomplete or corrupt timings", () => {
  const report = descriptor();
  parseTrendReport(reportHtml(undefined, { startTime: null }), report);
  assert.equal(report.timeSource, "attempt");
  parseTrendReport(
    reportHtml(
      [
        trendTest({
          results: [{ retry: 0, duration: 120000, status: "passed" }],
        }),
      ],
      { startTime: null },
    ),
    report,
  );
  assert.equal(report.timeSource, "catalog");
  assert.equal(report.timestamp, report.createdAt);
  assert.throws(
    () =>
      parseTrendReport(reportHtml([trendTest({ duration: 1 })]), descriptor()),
    /do not match/,
  );
  assert.throws(
    () => parseTrendReport("no embedded data", descriptor()),
    /missing/,
  );
});

test("on-demand API is read-only and live links survive moves but reject replacement", async (context) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { fork } = require("node:child_process");
  const { once } = require("node:events");
  const root = fs.mkdtempSync(path.join(__dirname, ".trends-"));
  const child = fork(path.join(__dirname, "artifact-test-server.cjs"), [], {
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      ARTIFACT_TEST_ROOT: root,
      ARTIFACT_TEST_SEED: "trends",
      PLAYWRIGHT_REPORTS_DB_PATH: path.join(root, "app.db"),
    },
  });
  context.after(async () => {
    const exit = once(child, "exit");
    child.kill();
    await exit;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const [{ url }] = await once(child, "message");
  const post = async (route, body) =>
    fetch(url + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const catalog = await (await fetch(url + "/api/reports")).json();
  assert.ok(catalog.current.every((report) => report.uuid));
  const Database = require("better-sqlite3");
  const database = new Database(path.join(root, "app.db"), { readonly: true });
  context.after(() => database.close());
  const before = database.prepare("SELECT * FROM reports ORDER BY id").all();
  const data = await (
    await post("/api/trends", {
      reportUuids: ["daily-uuid-11", "daily-uuid-8", "fixture-uuid", "missing"],
    })
  ).json();
  assert.equal(data.reports.filter((report) => report.issue).length, 2);
  assert.equal(data.series.length, 3);
  assert.deepEqual(
    database.prepare("SELECT * FROM reports ORDER BY id").all(),
    before,
  );
  assert.equal(fs.existsSync(path.join(root, "commands.log")), false);
  const report = data.reports.find((entry) => entry.uuid === "daily-uuid-11");
  const link =
    `/api/trends/reports/${report.uuid}/test?` +
    new URLSearchParams({
      testId: "daily-test-11",
      version: report.version,
      run: "0",
    });
  const navigate = () => fetch(url + link, { redirect: "manual" });
  assert.equal((await navigate()).status, 302);
  assert.equal(
    (
      await post("/api/report-rename", {
        reportId: "daily-12",
        newName: "renamed report",
      })
    ).status,
    200,
  );
  const renamed = await navigate();
  assert.match(
    renamed.headers.get("location"),
    /renamed%20report\/index.html#\?testId=daily-test-11&run=0$/,
  );
  assert.equal(
    (
      await post("/api/archive", {
        reportPath: "/reports/current/renamed report/index.html",
      })
    ).status,
    200,
  );
  const archived = await navigate();
  assert.equal(archived.status, 302);
  assert.match(archived.headers.get("location"), /^\/reports\/archive\//);
  const archivedRecord = database
    .prepare("SELECT * FROM reports WHERE uuid = ?")
    .get(report.uuid);
  const file = path.join(root, "archive", archivedRecord.id, "index.html");
  fs.appendFileSync(file, "\nchanged");
  assert.equal((await navigate()).status, 409);
  fs.unlinkSync(file);
  assert.equal((await navigate()).status, 404);
  assert.equal((await post("/api/trends", { reportUuids: [123] })).status, 400);
  assert.equal(
    (await fetch(url + "/api/report-search?rangeStart=2026-02-30")).status,
    400,
  );
  assert.equal(
    (await fetch(url + link.replace("run=0", "run=-1"))).status,
    400,
  );
});

test("date bounds use both unsorted scopes and reject impossible dates", () => {
  const bounds = model.dateBounds([
    { createdAt: "2026-06-10T22:00:00-05:00" },
    { createdAt: "2026-06-02T00:00:00Z" },
    { createdAt: "2026-06-09T00:00:00Z" },
  ]);
  assert.equal(bounds.rangeStart, "2026-06-02");
  assert.equal(bounds.rangeEnd, "2026-06-11");
  assert.equal(model.dateBounds([]).rangeStart, "");
  assert.equal(
    model.dateBounds([{ createdAt: "2026-06-02" }]).rangeEnd,
    "2026-06-02",
  );
  assert.ok(
    model.validateFilters({
      rangeStart: "2026-02-30",
      rangeEnd: "",
      query: "",
    }),
  );
  assert.ok(
    model.validateFilters({
      rangeStart: "2026-06-03",
      rangeEnd: "2026-06-02",
      query: "",
    }),
  );
});

test("baseline excludes latest and never carries earlier duration into missing or failed latest", () => {
  const reports = Array.from({ length: 6 }, (_, index) => ({
    ...descriptor(`report-${index}`),
    timestamp: `2026-06-0${index + 1}T07:00:00Z`,
  }));
  const entries = reports.flatMap((report, index) =>
    parseTrendReport(
      reportHtml([
        trendTest({
          duration: (index + 1) * 1000,
          results: [
            { retry: 0, duration: (index + 1) * 1000, status: "passed" },
          ],
        }),
      ]),
      report,
    ),
  );
  reports.forEach((report, index) => {
    report.timestamp = `2026-06-0${index + 1}T07:00:00Z`;
  });
  const [series] = mergeTrendSeries(entries);
  const stats = model.statistics(series, reports, "passed");
  assert.equal(stats.baseline, 3000);
  assert.equal(stats.change, 100);
  assert.equal(
    model.statistics(series, reports.slice(0, 1), "passed").baseline,
    null,
  );
  const missing = { ...series, observations: series.observations.slice(0, -1) };
  assert.equal(model.statistics(missing, reports, "passed").latest, null);
  series.observations[5].passed = null;
  assert.equal(model.statistics(series, reports, "passed").change, null);
  series.ambiguous = true;
  assert.equal(model.statistics(series, reports, "total").baseline, null);
});

test("export is an allowlisted single-test snapshot with inert report text", () => {
  const report = descriptor();
  report.name = "</script><script>globalThis.compromised=true</script>";
  const [series] = parseTrendReport(reportHtml(), report);
  series.file = "/private/secret/project/order.spec.ts";
  series.observations[0].secret = "must-not-export";
  const other = { ...series, key: "other", title: "EXCLUDED TEST" };
  const snapshot = model.selectedSnapshot(
    {
      schemaVersion: 1,
      generatedAt: "now",
      reports: [report],
      series: [series, other],
    },
    series,
    [report],
    { query: "DEV NA", rangeStart: "", rangeEnd: "" },
    "passed",
  );
  assert.equal(snapshot.data.series.length, 1);
  assert.equal(snapshot.data.series[0].file, "order.spec.ts");
  const output = model.snapshotHtml(snapshot, "", "", "");
  for (const forbidden of [
    "EXCLUDED TEST",
    "must-not-export",
    "/private/secret",
    "test-id",
    "<script>globalThis.compromised",
  ])
    assert.equal(output.includes(forbidden), false);
  assert.ok(output.includes("connect-src 'none'"));
});
