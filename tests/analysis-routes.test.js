const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { startHub } = require("./helpers/hub.cjs");

test("dashboard uses the published engine and keeps UUID paths, evidence and vault links", async (t) => {
  const hub = await startHub(t, "", { ARTIFACT_TEST_REAL_ANALYZER: "1" });
  const response = await hub.request("/api/failures", {
    reportPath: "/reports/current/fixture-report/index.html",
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.ai.analyzed, 2);
  assert.equal(response.data.grouping.problemCount, 1);
  assert.equal(response.data.groupingDiagnostics.model, "synthetic-big");
  assert.match(response.data.runDir, /analysis-fixture-uuid/);
  assert.match(path.basename(response.data.runDir), /-fixture-uuid$/);
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
