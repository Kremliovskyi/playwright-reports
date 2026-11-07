const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { startHub } = require("./helpers/hub.cjs");
const {
  validateManifest,
} = require("@andrii_kremlovskyi/playwright-failure-analyzer");

test("dashboard persists the canonical published bundle while keeping report ownership", async (t) => {
  const hub = await startHub(t, "", { ARTIFACT_TEST_REAL_ANALYZER: "1" });
  const response = await hub.request("/api/failures", {
    reportPath: "/reports/current/fixture-report/index.html",
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.ai.analyzed, 2);
  assert.equal(response.data.grouping.problemCount, 1);
  assert.equal(response.data.groupingDiagnostics.model, "synthetic-big");
  assert.match(response.data.runDir, /analysis-fixture-uuid/);
  assert.match(
    path.basename(response.data.runDir),
    /^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[A-Za-z0-9]{6}$/,
  );
  assert.equal(response.data.coverage.known, false);
  assert.ok(
    response.data.warnings.some((warning) =>
      warning.includes("coverage is unknown"),
    ),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(response.data.runDir, "index.json"), "utf8"),
  );
  assert.equal(manifest.runDir, response.data.runDir);
  assert.equal(manifest.schemaVersion, 2);
  const result = JSON.parse(
    fs.readFileSync(
      path.join(response.data.runDir, "analysis-result.json"),
      "utf8",
    ),
  );
  assert.deepEqual(result, response.data.analysisResult);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.versions.analyzer, "0.1.5");
  assert.equal(result.versions.sdk, "1.0.29");
  assert.equal(result.runId, path.basename(result.runDir));
  assert.equal(
    result.runId.slice(4, -7),
    result.createdAt.replace(/[:.]/g, "-"),
  );
  assert.deepEqual(result.source, {
    kind: "playwright-reports",
    reportUuid: "fixture-uuid",
    reportName: "fixture-report",
  });
  assert.equal(result.status, "partial");
  assert.equal(response.data.success, false);
  assert.match(
    fs.readFileSync(path.join(result.runDir, "summary.md"), "utf8"),
    /Status: \*\*partial\*\*/,
  );
  for (const entry of manifest.failures) {
    const record = JSON.parse(
      fs.readFileSync(
        path.join(manifest.runDir, entry.folder, "evidence.json"),
        "utf8",
      ),
    );
    assert.equal(record.schemaVersion, 4);
    assert.equal(record.warning, undefined);
    assert.equal(record.error, undefined);
    assert.equal(record.issues.length, 1);
    assert.equal(record.model, "synthetic-small");
  }
  const info = await hub.request(
    "/api/report-info?reportId=fixture-report",
    undefined,
    "GET",
  );
  assert.equal(info.data.runs.length, 1);
  assert.equal(info.data.runs[0].groupedAnalysisExists, true);
  assert.equal(info.data.runs[0].createdAt, result.createdAt);
  const relocated = path.join(
    hub.root,
    "downloaded wrapper with spaces",
    result.runId,
  );
  fs.cpSync(result.runDir, relocated, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const localManifest = validateManifest(
    JSON.parse(fs.readFileSync(path.join(relocated, "index.json"), "utf8")),
    relocated,
  );
  assert.equal(localManifest.runDir, relocated);
  assert.deepEqual(localManifest.failures, response.data.manifest.failures);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(relocated, "analysis-result.json"), "utf8"),
    ),
    result,
  );
  for (const artifact of Object.values(result.artifacts)) {
    if (typeof artifact === "string")
      assert.ok(fs.existsSync(path.join(relocated, artifact)));
  }
});

test("preparation failure retains a registered result and summary for inspection", async (t) => {
  const hub = await startHub(t);
  fs.writeFileSync(path.join(hub.root, "command-fail"), "");
  const response = await hub.request("/api/failures", {
    reportPath: "/reports/current/fixture-report/index.html",
  });
  assert.equal(response.status, 500);
  const result = response.data.analysisResult;
  assert.equal(result.status, "failed");
  assert.equal(result.errors[0].stage, "preparation");
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(result.runDir, "analysis-result.json"), "utf8"),
    ),
    result,
  );
  assert.ok(fs.existsSync(path.join(result.runDir, "summary.md")));
  const info = await hub.request(
    "/api/report-info?reportId=fixture-report",
    undefined,
    "GET",
  );
  assert.equal(info.data.runs[0].runDir, result.runDir);
  assert.equal(info.data.runs[0].failuresUrl, null);
});

test("canonical finals remain linked after output deletion and can be deleted explicitly", async (t) => {
  const hub = await startHub(t, "", { ARTIFACT_TEST_REAL_ANALYZER: "1" });
  const response = await hub.request("/api/failures", {
    reportPath: "/reports/current/fixture-report/index.html",
  });
  assert.equal(response.status, 200);
  const result = response.data.analysisResult;
  const note = path.join(result.runDir, "final-analysis.md");
  const retained = path.join(
    hub.root,
    "current",
    "analysis",
    "fixture-uuid",
    result.runId,
    "final-analysis.md",
  );
  fs.writeFileSync(note, "# Saved comparison");
  fs.writeFileSync(
    path.join(path.dirname(result.runDir), "unregistered-note.md"),
    "# Not registered",
  );
  const getInfo = () =>
    hub.request("/api/report-info?reportId=fixture-report", undefined, "GET");
  const before = await getInfo();
  assert.equal(before.data.analysisInventory.entries[0].notes[0].path, note);
  const deleted = await hub.request(
    "/api/analysis-run/output-dir",
    { reportId: "fixture-report", runName: result.runId },
    "DELETE",
  );
  assert.equal(deleted.status, 200);
  assert.ok(fs.existsSync(retained));
  const after = await getInfo();
  assert.equal(after.data.analysisInventory.entries[0].notes[0].path, retained);
  const listing = await hub.request("/api/agent/vault/list", undefined, "GET");
  assert.equal(listing.status, 200);
  assert.deepEqual(
    listing.data.files.map((file) => file.filename),
    [result.runId],
  );
  assert.equal(
    (await hub.request("/api/agent/vault/unregistered-note", undefined, "GET"))
      .status,
    404,
  );
  const page = await fetch(hub.url + "/vault/" + result.runId);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Saved comparison/);
  const removed = await hub.request(
    "/api/analysis-run/analysis-file",
    { reportId: "fixture-report", runName: result.runId },
    "DELETE",
  );
  assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(retained), false);
});

test("source-only fallbacks remain visible as dashboard warnings", async (t) => {
  const hub = await startHub(t, "", { ARTIFACT_TEST_REAL_ANALYZER: "1" });
  fs.writeFileSync(path.join(hub.root, "invalid-ai"), "");
  const response = await hub.request("/api/failures", {
    reportPath: "/reports/current/fixture-report/index.html",
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.ai.analyzed, 2);
  assert.ok(
    response.data.warnings.some((warning) => /fallback|source/i.test(warning)),
  );
  assert.ok(response.data.groupingError);
  assert.ok(fs.existsSync(path.join(response.data.runDir, "index.json")));
});

for (const [marker, status, code] of [
  ["typed-auth-fail", 401, "COPILOT_NOT_AUTHENTICATED"],
  ["model-fail", 409, "COPILOT_MODEL_UNAVAILABLE"],
]) {
  test(`${code} from the package preserves the previous output before replacement`, async (t) => {
    const hub = await startHub(t, "browser");
    const before = await hub.request(
      "/api/report-info?reportId=fixture-report",
      undefined,
      "GET",
    );
    fs.writeFileSync(path.join(hub.root, marker), "");
    const response = await hub.request("/api/failures", {
      reportPath: "/reports/current/fixture-report/index.html",
      replaceRunId: before.data.analysisInventory.entries[0].id,
      analysisVersion: before.data.analysisInventory.version,
    });
    assert.equal(response.status, status, JSON.stringify(response.data));
    assert.equal(response.data.code, code);
    if (marker === "model-fail") assert.equal(response.data.modelRole, "small");
    assert.ok(fs.existsSync(before.data.runs[0].runDir));
    assert.equal(fs.existsSync(path.join(hub.root, "commands.log")), false);
    const after = await hub.request(
      "/api/report-info?reportId=fixture-report",
      undefined,
      "GET",
    );
    assert.deepEqual(after.data.runs, before.data.runs);
  });
}

test("access and model picker endpoints keep their separate contracts", async (t) => {
  const hub = await startHub(t, "", { ARTIFACT_TEST_REAL_ANALYZER: "1" });
  const status = await hub.request("/api/copilot-status", undefined, "GET");
  assert.equal(status.data.authenticated, true);
  assert.equal(status.data.availableModels, undefined);
  const models = await hub.request("/api/copilot-models", undefined, "GET");
  assert.deepEqual(models.data.availableModels, [
    "synthetic-small",
    "synthetic-big",
  ]);
  assert.equal(models.data.smallModel, "synthetic-small");
  assert.equal(models.data.bigModel, "synthetic-big");
  assert.equal(fs.existsSync(path.join(hub.root, "commands.log")), false);
});
