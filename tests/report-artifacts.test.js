const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  analysisInventory,
  removeAnalysisArtifacts,
} = require("../dist/report-artifacts");
const {
  traceIdentity,
  publishDigest,
  reportArtifactRoot,
} = require("../dist/report-artifacts");
const { moveLegacyDigest } = require("../dist/report-artifacts");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(__dirname, ".artifacts-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roots = {
    currentPath: path.join(root, "current"),
    archivePath: path.join(root, "archive"),
    vaultPath: path.join(root, "vault"),
  };
  function run(
    name,
    { archived = false, output = !archived, note = true } = {},
  ) {
    const runDir = output ? path.join(roots.currentPath, "tmp", name) : "";
    if (output) {
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "grouped-analysis.md"),
        `Grouped ${name}`,
      );
    }
    if (note) {
      const noteRoot = archived
        ? path.join(roots.archivePath, "analysis")
        : roots.vaultPath;
      fs.mkdirSync(noteRoot, { recursive: true });
      fs.writeFileSync(path.join(noteRoot, name + ".md"), `Saved ${name}`);
    }
    return {
      id: name,
      reportId: "report-uuid",
      runName: name,
      runDir,
      createdAt: "2026-09-18",
    };
  }
  return { root, roots, run };
}

for (const archived of [false, true]) {
  test(`single ${archived ? "archived" : "current"} analysis inspection preserves files and metadata`, (context) => {
    const { roots, run } = fixture(context);
    const record = run("existing", { archived });
    const before = structuredClone(record);
    const first = analysisInventory(roots, [record]);
    for (let iteration = 0; iteration < 3; iteration++) {
      assert.deepEqual(analysisInventory(roots, [record]), first);
      assert.equal(first.needsReview, false);
      assert.equal(first.duplicated, false);
      assert.deepEqual(record, before);
    }
    for (const note of first.entries[0].notes)
      assert.equal(fs.readFileSync(note.path, "utf8"), "Saved existing");
  });
}

test("duplicate detection preserves history until exact confirmation", (context) => {
  const { roots, run } = fixture(context);
  const records = [run("older"), run("newer")];
  const inventory = analysisInventory(roots, records);
  assert.equal(inventory.duplicated, true);
  assert.ok(fs.existsSync(records[0].runDir));
  assert.throws(
    () => removeAnalysisArtifacts(roots, records, "stale", "older"),
    /changed/,
  );
  assert.ok(fs.existsSync(records[1].runDir));
  assert.deepEqual(
    removeAnalysisArtifacts(roots, records, inventory.version, "older"),
    ["newer"],
  );
  assert.ok(fs.existsSync(records[0].runDir));
  assert.equal(fs.existsSync(records[1].runDir), false);
  assert.equal(
    fs.readFileSync(path.join(roots.vaultPath, "older.md"), "utf8"),
    "Saved older",
  );
});

test("duplicate cleanup never deletes the only note or only output", (context) => {
  const { roots, run } = fixture(context);
  const records = [run("complete"), run("output-only", { note: false })];
  const inventory = analysisInventory(roots, records);
  assert.match(inventory.choices[1].blockedReason, /every saved analysis/);
  assert.throws(
    () =>
      removeAnalysisArtifacts(roots, records, inventory.version, "output-only"),
    /every saved analysis/,
  );
  assert.ok(fs.existsSync(records[0].runDir));
});

test("complementary and repeated records are review-only, not duplicate deletion candidates", (context) => {
  const { roots, run } = fixture(context);
  const output = run("output", { note: false });
  const note = run("note", { output: false });
  for (const records of [
    [output, note],
    [output, { ...output, id: "reference" }],
  ]) {
    const inventory = analysisInventory(roots, records);
    assert.equal(inventory.duplicated, false);
    assert.equal(inventory.needsReview, true);
    assert.ok(inventory.choices.every((choice) => choice.blockedReason));
  }
});

test("unsafe and shared artifact paths cannot be removed", (context) => {
  const { root, roots, run } = fixture(context);
  const original = run("owned");
  const inventory = analysisInventory(roots, [original]);
  assert.throws(
    () =>
      removeAnalysisArtifacts(roots, [original], inventory.version, undefined, [
        { ...original, id: "other", reportId: "other-report" },
      ]),
    /Another analysis/,
  );
  const unsafe = { ...original, runDir: root };
  assert.equal(analysisInventory(roots, [unsafe]).needsReview, true);
  const link = path.join(roots.currentPath, "tmp", "link");
  fs.symlinkSync(original.runDir, link, "dir");
  assert.match(
    analysisInventory(roots, [{ ...original, runDir: link }]).issues.join(" "),
    /Symbolic links/,
  );
  assert.ok(fs.existsSync(original.runDir));
});

test("confirmed replacement deletes analysis but not manual digests", (context) => {
  const { roots, run } = fixture(context);
  const record = run("analysis");
  const digest = path.join(roots.currentPath, "tmp", "digests-report", "trace");
  fs.mkdirSync(digest, { recursive: true });
  const inventory = analysisInventory(roots, [record]);
  removeAnalysisArtifacts(roots, [record], inventory.version);
  assert.ok(fs.existsSync(digest));
  assert.equal(fs.existsSync(record.runDir), false);
});

test("digest replacement isolates traces, removes stale files and rolls back persistence failures", (context) => {
  const { root, roots } = fixture(context);
  const report = path.join(root, "report");
  const firstKey = traceIdentity(
    report,
    path.join(report, "data", "first.zip"),
  );
  const secondKey = traceIdentity(
    report,
    path.join(report, "data", "second.zip"),
  );
  assert.equal(
    firstKey,
    traceIdentity(report, path.join(report, "data", "first")),
  );
  assert.notEqual(firstKey, secondKey);
  assert.throws(
    () => traceIdentity(report, path.join(root, "other.zip")),
    /outside/,
  );
  const digestRoot = reportArtifactRoot(
    roots.currentPath,
    "report-uuid",
    "digests",
  );
  function staged(content, extra = false) {
    fs.mkdirSync(digestRoot, { recursive: true });
    const stagedDir = fs.mkdtempSync(path.join(digestRoot, ".staging-"));
    fs.writeFileSync(path.join(stagedDir, "digest.json"), content);
    if (extra) fs.writeFileSync(path.join(stagedDir, "old-body.ndjson"), "old");
    return stagedDir;
  }
  const first = publishDigest(
    digestRoot,
    firstKey,
    staged("first", true),
    () => {},
  );
  const second = publishDigest(
    digestRoot,
    secondKey,
    staged("second"),
    () => {},
  );
  assert.throws(
    () =>
      publishDigest(digestRoot, firstKey, staged("failed"), () => {
        throw new Error("DB unavailable");
      }),
    /DB unavailable/,
  );
  assert.equal(
    fs.readFileSync(path.join(first, "digest.json"), "utf8"),
    "first",
  );
  publishDigest(digestRoot, firstKey, staged("refreshed"), () => {});
  assert.equal(fs.existsSync(path.join(first, "old-body.ndjson")), false);
  assert.equal(
    fs.readFileSync(path.join(second, "digest.json"), "utf8"),
    "second",
  );
});

test("database upgrade preserves legacy analyses and guards new writes", (context) => {
  const { root, roots, run } = fixture(context);
  const databasePath = path.join(root, "isolated.db");
  const Database = require("better-sqlite3");
  const database = new Database(databasePath);
  database.exec(
    "CREATE TABLE analysis_runs (id TEXT PRIMARY KEY, reportId TEXT NOT NULL, runDir TEXT NOT NULL, runName TEXT NOT NULL, createdAt TEXT NOT NULL)",
  );
  const records = [
    run("single"),
    { ...run("archived", { archived: true }), reportId: "archived-uuid" },
  ];
  for (const record of records)
    database
      .prepare(
        "INSERT INTO analysis_runs VALUES (@id, @reportId, @runDir, @runName, @createdAt)",
      )
      .run(record);
  database.close();
  const before = analysisInventory(roots, records);
  const { execFileSync } = require("node:child_process");
  const script = `
    const assert = require('node:assert/strict');
    const store = require('./dist/db');
    assert.equal(store.getAllAnalysisRuns().length, 2);
    assert.throws(() => store.addAnalysisRun({ id: 'new', reportId: 'report-uuid', runDir: '/unused', runName: 'new', createdAt: '' }), /already has/);
    store.addDigest({ id: 'original', reportId: 'report-uuid', traceKey: 'trace', runDir: '/tmp/digests', folder: 'trace', testTitle: 'test', createdAt: 'before' });
    store.addDigest({ id: 'replacement', reportId: 'report-uuid', traceKey: 'trace', runDir: '/tmp/digests', folder: 'trace', testTitle: 'test', createdAt: 'after' });
    assert.equal(store.getDigests('report-uuid').length, 1);
    assert.equal(store.getDigests('report-uuid')[0].id, 'original');
  `;
  for (let iteration = 0; iteration < 2; iteration++)
    execFileSync(process.execPath, ["-e", script], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PLAYWRIGHT_REPORTS_DB_PATH: databasePath },
    });
  assert.deepEqual(analysisInventory(roots, records), before);
});

test("legacy digest relocation recovers an interrupted database update without data loss", (context) => {
  const { roots, run } = fixture(context);
  const analysis = run("preserved-analysis");
  const root = reportArtifactRoot(roots.currentPath, "report-uuid", "digests");
  fs.mkdirSync(root, { recursive: true });
  const digest = {
    id: "old-id",
    runDir: path.join(roots.currentPath, "tmp", "old-run"),
    folder: "trace",
  };
  const source = path.join(digest.runDir, digest.folder);
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "digest.json"), "original");
  assert.throws(
    () =>
      moveLegacyDigest(root, digest, () => {
        throw new Error("DB failure");
      }),
    /DB failure/,
  );
  assert.equal(
    fs.readFileSync(path.join(source, "digest.json"), "utf8"),
    "original",
  );
  fs.renameSync(source, path.join(root, "legacy-old-id"));
  let recoveredFolder;
  moveLegacyDigest(root, digest, (folder) => {
    recoveredFolder = folder;
  });
  assert.equal(recoveredFolder, "legacy-old-id");
  assert.equal(
    fs.readFileSync(path.join(root, recoveredFolder, "digest.json"), "utf8"),
    "original",
  );
  assert.ok(fs.existsSync(analysis.runDir));
});

test("installed trace-reader digest remains self-contained after publication", (context) => {
  const { root, roots } = fixture(context);
  const reportRoot = path.join(root, "synthetic-report");
  const traceDirectory = path.join(reportRoot, "data", "synthetic-trace");
  fs.mkdirSync(traceDirectory, { recursive: true });
  const events = [
    {
      type: "context-options",
      version: 8,
      origin: "testRunner",
      browserName: "chromium",
      options: {},
      platform: process.platform,
      wallTime: 1700000000000,
      monotonicTime: 0,
      sdkLanguage: "javascript",
      contextId: "test-context",
    },
    {
      type: "before",
      callId: "test@1",
      startTime: 1,
      class: "Test",
      method: "step",
      apiName: "synthetic test",
      params: {},
      title: "Synthetic test",
    },
    { type: "after", callId: "test@1", endTime: 2 },
  ];
  fs.writeFileSync(
    path.join(traceDirectory, "test.trace"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const output = reportArtifactRoot(
    roots.currentPath,
    "reader-fixture",
    "digests",
  );
  fs.mkdirSync(output, { recursive: true });
  const staging = fs.mkdtempSync(path.join(output, ".staging-"));
  const cliPath = path.join(
    path.dirname(
      require.resolve("@andrii_kremlovskyi/playwright-traces-reader"),
    ),
    "cli.js",
  );
  const { execFileSync } = require("node:child_process");
  const manifest = JSON.parse(
    execFileSync(
      process.execPath,
      [cliPath, "digest", traceDirectory, staging, "--format", "json"],
      { cwd: path.join(__dirname, ".."), encoding: "utf8" },
    ),
  );
  const traceKey = traceIdentity(reportRoot, traceDirectory);
  const published = publishDigest(
    output,
    traceKey,
    path.join(manifest.runDir, manifest.folder),
    () => {},
  );
  const digest = JSON.parse(
    fs.readFileSync(path.join(published, "digest.json"), "utf8"),
  );
  assert.equal(traceIdentity(reportRoot, digest.tracePath), traceKey);
  assert.equal(digest.command, "digest");
  for (const relative of Object.values(digest.files).filter(Boolean))
    assert.ok(fs.existsSync(path.join(published, relative)));
});

test("API confirmation, failed rerun and shared digest root use isolated synthetic data", async (context) => {
  const { root } = fixture(context);
  const { fork } = require("node:child_process");
  const { once } = require("node:events");
  const child = fork(path.join(__dirname, "artifact-test-server.cjs"), [], {
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      ARTIFACT_TEST_ROOT: root,
      PLAYWRIGHT_REPORTS_DB_PATH: path.join(root, "api.db"),
    },
  });
  context.after(async () => {
    child.kill();
    await once(child, "exit");
  });
  const [{ url, reportRoot }] = await once(child, "message");
  const reportPath = "/reports/current/fixture-report/index.html";
  async function post(endpoint, body) {
    const response = await fetch(url + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  async function info() {
    return (
      await fetch(url + "/api/report-info?reportId=fixture-report")
    ).json();
  }
  fs.writeFileSync(path.join(root, "hold-command"), "");
  const commandStarted = once(child, "message");
  const firstRequest = post("/api/failures", { reportPath });
  assert.equal((await commandStarted)[0].event, "command-started");
  assert.equal(
    (await post("/api/failures", { reportPath })).data.code,
    "FAILURE_ANALYSIS_IN_PROGRESS",
  );
  assert.equal(
    (await post("/api/archive", { reportPath })).data.code,
    "REPORT_ARTIFACTS_BUSY",
  );
  assert.equal((await post("/api/config", { currentPath: root })).status, 409);
  fs.unlinkSync(path.join(root, "hold-command"));
  child.send({ resume: true });
  const first = await firstRequest;
  assert.equal(first.status, 200);
  const original = await info();
  assert.equal(original.runs.length, 1);
  assert.ok(original.runs[0].runName.endsWith("-fixture-uuid"));
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(first.data.runDir, "index.json"), "utf8"),
    ).runDir,
    first.data.runDir,
  );
  const warning = await post("/api/failures", { reportPath });
  assert.equal(warning.data.code, "ANALYSIS_REPLACEMENT_REQUIRED");
  assert.equal(
    fs.readFileSync(path.join(root, "commands.log"), "utf8"),
    "failures\n",
  );
  assert.deepEqual((await info()).runs, original.runs);
  const noteName = original.runs[0].runName;
  const notePath = path.join(root, "vault", noteName + ".md");
  fs.writeFileSync(notePath, "Important existing note");
  const { contentVersion } = require("../dist/report-artifacts");
  const staleSave = {
    content: "Stale editor text",
    expectedVersion: contentVersion("Important existing note"),
  };
  const noteWarning = await post("/api/failures", { reportPath });
  const consent = {
    reportPath,
    replaceRunId: noteWarning.data.runId,
    analysisVersion: noteWarning.data.inventory.version,
  };
  fs.writeFileSync(path.join(root, "auth-fail"), "");
  assert.equal((await post("/api/failures", consent)).status, 500);
  assert.ok(fs.existsSync(first.data.runDir));
  fs.unlinkSync(path.join(root, "auth-fail"));
  const replacement = await post("/api/failures", consent);
  assert.equal(replacement.status, 200);
  assert.equal(fs.existsSync(first.data.runDir), false);
  const rejectedSave = await fetch(url + "/api/vault/" + noteName, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(staleSave),
  });
  assert.equal(rejectedSave.status, 409);
  assert.equal(fs.existsSync(notePath), false);
  assert.equal((await info()).runs.length, 1);
  assert.equal(
    (await post("/api/failures", consent)).data.code,
    "ANALYSIS_REPLACEMENT_REQUIRED",
  );
  const digestFirst = await post("/api/digest-test", {
    reportPath,
    tracePath: path.join(reportRoot, "data", "first.zip"),
  });
  const digestSecond = await post("/api/digest-test", {
    reportPath,
    tracePath: path.join(reportRoot, "data", "second.zip"),
  });
  assert.equal(digestFirst.status, 200, JSON.stringify(digestFirst.data));
  assert.equal(digestSecond.status, 200);
  assert.equal(
    digestFirst.data.manifest.runDir,
    digestSecond.data.manifest.runDir,
  );
  assert.notEqual(
    digestFirst.data.manifest.folder,
    digestSecond.data.manifest.folder,
  );
  const repeated = await post("/api/digest-test", {
    reportPath,
    tracePath: path.join(reportRoot, "data", "first.zip"),
  });
  assert.equal(repeated.data.digestFolder, digestFirst.data.digestFolder);
  assert.equal((await info()).digests.length, 2);
  assert.equal(
    (await fetch(url + repeated.data.digestUrl + "/digest.json")).status,
    200,
  );
  const digestInfo = await info();
  const removedDigest = digestInfo.digests[0];
  const otherDigest = digestInfo.digests[1];
  const deleteResponse = await fetch(url + "/api/digest", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reportId: "fixture-report",
      digestId: removedDigest.id,
    }),
  });
  assert.equal(deleteResponse.status, 200);
  assert.ok(fs.existsSync(otherDigest.digestDir));
  assert.equal((await info()).digests.length, 1);
  const Database = require("better-sqlite3");
  const database = new Database(path.join(root, "api.db"));
  context.after(() => database.close());
  const duplicateDir = path.join(root, "current", "tmp", "legacy-duplicate");
  fs.mkdirSync(duplicateDir);
  fs.writeFileSync(path.join(duplicateDir, "index.json"), "{}");
  database
    .prepare("INSERT INTO analysis_runs VALUES (?, ?, ?, ?, ?)")
    .run(
      "duplicate",
      "fixture-uuid",
      duplicateDir,
      "legacy-duplicate",
      "2020-01-01",
    );
  const duplicates = await info();
  assert.equal(duplicates.analysisInventory.duplicated, true);
  assert.equal(
    (await post("/api/failures", { reportPath })).data.code,
    "ANALYSIS_REVIEW_REQUIRED",
  );
  assert.equal(
    (
      await post("/api/analysis/consolidate", {
        reportId: "fixture-report",
        keepRunId: "duplicate",
        version: "stale",
      })
    ).status,
    409,
  );
  assert.ok(fs.existsSync(replacement.data.runDir));
  const currentRun = duplicates.analysisInventory.entries.find(
    (entry) => entry.id !== "duplicate",
  );
  const consolidated = await post("/api/analysis/consolidate", {
    reportId: "fixture-report",
    keepRunId: currentRun.id,
    version: duplicates.analysisInventory.version,
  });
  assert.equal(consolidated.status, 200, JSON.stringify(consolidated.data));
  assert.equal(fs.existsSync(duplicateDir), false);
  assert.ok(fs.existsSync(replacement.data.runDir));
  assert.equal((await info()).runs.length, 1);
  const finalWarning = await post("/api/failures", { reportPath });
  fs.writeFileSync(path.join(root, "command-fail"), "");
  const failed = await post("/api/failures", {
    reportPath,
    replaceRunId: finalWarning.data.runId,
    analysisVersion: finalWarning.data.inventory.version,
  });
  assert.equal(failed.status, 500);
  assert.equal((await info()).runs.length, 0);
  assert.equal((await info()).digests.length, 1);
  fs.unlinkSync(path.join(root, "command-fail"));
  const recreated = await post("/api/failures", { reportPath });
  assert.equal(recreated.status, 200);
  const lastInfo = await info();
  const retainedNote = lastInfo.runs[0].runName;
  fs.writeFileSync(
    path.join(root, "vault", retainedNote + ".md"),
    "Retain on archive",
  );
  const archived = await post("/api/archive", { reportPath });
  assert.equal(archived.status, 200);
  assert.equal(
    fs.readFileSync(
      path.join(root, "archive", "analysis", retainedNote + ".md"),
      "utf8",
    ),
    "Retain on archive",
  );
  const archiveInfo = await (
    await fetch(url + "/api/report-info?reportId=" + archived.data.newName)
  ).json();
  assert.equal(archiveInfo.runs.length, 1);
  assert.equal(archiveInfo.digests.length, 0);
  assert.equal(archiveInfo.analysisInventory.needsReview, false);
});
