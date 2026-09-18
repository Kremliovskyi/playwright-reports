const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const root = process.env.ARTIFACT_TEST_ROOT;
if (!root || !process.env.PLAYWRIGHT_REPORTS_DB_PATH)
  throw new Error("Isolated test storage is required");
const store = require("../dist/db");
const config = {
  ...store.getConfig(),
  currentPath: path.join(root, "current"),
  archivePath: path.join(root, "archive"),
  vaultPath: path.join(root, "vault"),
};
for (const directory of [
  config.currentPath,
  config.archivePath,
  config.vaultPath,
])
  fs.mkdirSync(directory, { recursive: true });
store.updateConfig(config);
const reportRoot = path.join(config.currentPath, "fixture-report");
fs.mkdirSync(path.join(reportRoot, "data"), { recursive: true });
fs.writeFileSync(
  path.join(reportRoot, "index.html"),
  "<title>Playwright Test Report</title>",
);
for (const name of ["first", "second"])
  fs.writeFileSync(
    path.join(reportRoot, "data", name + ".zip"),
    "synthetic trace",
  );
store.upsertReport({
  id: "fixture-report",
  uuid: "fixture-uuid",
  dateCreated: fs.statSync(reportRoot).birthtime.toISOString(),
  metadata: "",
  reportPath: "/reports/current/fixture-report/index.html",
});
if (process.env.ARTIFACT_TEST_SEED === "browser") {
  const Database = require("better-sqlite3");
  const database = new Database(process.env.PLAYWRIGHT_REPORTS_DB_PATH);
  for (const [reportId, count] of [
    ["fixture-report", 1],
    ["duplicate-report", 2],
  ]) {
    const directory = path.join(config.currentPath, reportId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "index.html"),
      "<title>Playwright Test Report</title>",
    );
    const uuid =
      reportId === "fixture-report" ? "fixture-uuid" : "duplicate-uuid";
    store.upsertReport({
      id: reportId,
      uuid,
      dateCreated: fs.statSync(directory).birthtime.toISOString(),
      metadata: "Synthetic browser fixture",
      reportPath: `/reports/current/${reportId}/index.html`,
    });
    for (let index = 0; index < count; index++) {
      const name = `${reportId}-analysis-${index}`;
      const output = path.join(config.currentPath, "tmp", name);
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, "index.json"), "{}");
      fs.writeFileSync(
        path.join(config.vaultPath, name + ".md"),
        `Preserve ${name}`,
      );
      database
        .prepare("INSERT INTO analysis_runs VALUES (?, ?, ?, ?, ?)")
        .run(name, uuid, output, name, new Date().toISOString());
    }
  }
  database.close();
}
if (process.env.ARTIFACT_TEST_SEED === "trends") {
  const { reportHtml, trendTest } = require("./trends-fixture.cjs");
  for (let index = 0; index < 12; index++) {
    const id = `daily-${String(index + 1).padStart(2, "0")}`;
    const scope = index === 11 ? "current" : "archive";
    const directory = path.join(config[scope + "Path"], id);
    fs.mkdirSync(directory, { recursive: true });
    const duration =
      [112, 115, 119, 118, 121, 135, 148, 158, 258, 190, 226, 240][index] *
      1000;
    const startTime = new Date(Date.UTC(2026, 8, index + 1, 7)).toISOString();
    const results =
      index === 8
        ? [
            { retry: 0, startTime, duration: 258000, status: "failed" },
            { retry: 1, startTime, duration: 234000, status: "failed" },
          ]
        : index === 6
          ? [
              { retry: 0, startTime, duration: 210000, status: "failed" },
              { retry: 1, startTime, duration, status: "passed" },
            ]
          : [{ retry: 0, startTime, duration, status: "passed" }];
    const tests = [
      trendTest({
        testId: `daily-test-${index}`,
        path: [`Orders [DEV NA - 9/${index + 1}]`],
        results,
        duration: results.reduce((sum, result) => sum + result.duration, 0),
        outcome:
          index === 8 ? "unexpected" : index === 6 ? "flaky" : "expected",
      }),
    ];
    if (index !== 10)
      tests.push(
        trendTest({
          testId: `second-${index}`,
          title: "e2eExampleTC02 - stable workflow",
          path: [`Orders [DEV NA - 9/${index + 1}]`],
        }),
      );
    if (index === 11)
      tests.push(
        trendTest({
          testId: "new-test",
          title: "e2eExampleTC03 - new workflow",
        }),
      );
    fs.writeFileSync(
      path.join(directory, "index.html"),
      reportHtml(tests, { startTime: Date.parse(startTime) }),
    );
    store.upsertReport({
      id,
      uuid: `daily-uuid-${index}`,
      dateCreated: fs.statSync(directory).birthtime.toISOString(),
      metadata: "DEV NA nightly",
      reportPath: `/reports/${scope}/${id}/index.html`,
    });
  }
}
let sequence = 0;
const analyzer = require("../dist/copilot-analyzer");
analyzer.copilotAccessCheck = async () => ({
  authenticated: true,
  available: true,
});
analyzer.copilotModels = async () => ({ models: [] });
analyzer.withCopilotAnalysisClient = async (_models, _token, operation) => {
  if (fs.existsSync(path.join(root, "auth-fail")))
    throw new Error("Synthetic authentication failure");
  return operation({});
};
analyzer.analyzeRun = async () => ({
  records: [],
  analyzed: 0,
  failed: 0,
  skipped: 0,
});
require("node:child_process").spawn = (_executable, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const complete = () => {
    try {
      const command = args[1];
      fs.appendFileSync(path.join(root, "commands.log"), command + "\n");
      if (fs.existsSync(path.join(root, "command-fail")))
        throw new Error("Synthetic CLI failure");
      if (command === "find-traces") {
        child.stdout.write(
          JSON.stringify({
            traces: ["first", "second"].map((name) => ({
              projectName: name,
              testTitle: "Same title " + name,
              file: "fixture.spec.ts",
              outcome: "expected",
              tracePath: path.join(reportRoot, "data", name + ".zip"),
            })),
          }),
        );
        child.emit("close", 0);
        return;
      }
      const runDir = path.join(args[3], "run-fixture-" + ++sequence);
      fs.mkdirSync(runDir, { recursive: true });
      let manifest;
      if (command === "failures") {
        manifest = { runDir, count: 0, failures: [] };
        fs.writeFileSync(
          path.join(runDir, "index.json"),
          JSON.stringify(manifest),
        );
      } else if (command === "digest") {
        const folder = "same-test-title__retry0";
        fs.mkdirSync(path.join(runDir, folder));
        fs.writeFileSync(
          path.join(runDir, folder, "digest.json"),
          JSON.stringify({
            tracePath: args[2],
            traceSha1: path.basename(args[2], ".zip"),
            generation: sequence,
          }),
        );
        manifest = {
          runDir,
          folder,
          testTitle: "Same title",
          traceSha1: path.basename(args[2], ".zip"),
        };
      } else throw new Error("Unsupported test command");
      child.stdout.write(JSON.stringify(manifest));
      child.emit("close", 0);
    } catch (error) {
      child.stderr.write(error.message);
      child.emit("close", 1);
    }
  };
  if (fs.existsSync(path.join(root, "hold-command"))) {
    process.once("message", complete);
    process.send?.({ event: "command-started" });
  } else setImmediate(complete);
  return child;
};
const { app } = require("../dist/server");
const server = app.listen(
  Number(process.env.ARTIFACT_TEST_PORT || 0),
  "127.0.0.1",
  () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    if (process.send) process.send({ url, reportRoot });
    console.log(url);
  },
);
