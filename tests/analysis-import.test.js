const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const AdmZip = require("adm-zip");
const { startHub } = require("./helpers/hub.cjs");

const target = { reportId: "fixture-report", reportUuid: "fixture-uuid" };
const info = (hub) =>
  hub.request("/api/report-info?reportId=fixture-report", undefined, "GET");
const digest = (directory) => {
  const hash = crypto.createHash("sha256");
  const walk = (folder) => {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name);
      hash.update(path.relative(directory, file));
      if (fs.statSync(file).isDirectory()) walk(file);
      else hash.update(fs.readFileSync(file));
    }
  };
  walk(directory);
  return hash.digest("hex");
};

async function sourceFixture(t, final = true) {
  const hub = await startHub(t, "", { ARTIFACT_TEST_REAL_ANALYZER: "1" });
  const generated = await hub.request("/api/failures", {
    reportPath: "/reports/current/fixture-report/index.html",
  });
  assert.equal(generated.status, 200, JSON.stringify(generated.data));
  const runName = generated.data.analysisResult.runId;
  const source = path.join(
    hub.root,
    "Downloads with spaces",
    "failure-analysis-wrapper",
    runName,
  );
  fs.cpSync(generated.data.runDir, source, { recursive: true });
  if (final)
    fs.writeFileSync(
      path.join(source, "final-analysis.md"),
      "# Final review\n\n<script>window.compromised = true</script>",
    );
  return { hub, source, runName, generated };
}

async function inspect(hub, source) {
  const preview = await hub.request("/api/analysis/import/preview", {
    ...target,
    sourcePath: source,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  return preview.data;
}

const commitBody = (preview) => ({
  ...target,
  sourcePath: preview.source,
  sourceVersion: preview.version,
  analysisVersion: preview.inventory.version,
  replaceRunId: preview.inventory.entries[0]?.id,
  confirmUnverified: true,
});

test("import registers grouped and final, scoped reads are safe, and deleting output preserves only the managed final", async (t) => {
  const { hub, source, runName } = await sourceFixture(t);
  const original = digest(source);
  const preview = await inspect(hub, path.dirname(source));
  assert.equal(preview.grouped, true);
  assert.equal(preview.finalName, "final-analysis.md");
  assert.equal(preview.verified, false);
  const rejected = await hub.request("/api/analysis/import", {
    ...commitBody(preview),
    confirmUnverified: false,
  });
  assert.equal(rejected.data.code, "ASSOCIATION_UNVERIFIED");
  const imported = await hub.request(
    "/api/analysis/import",
    commitBody(preview),
  );
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const current = await info(hub);
  const run = current.data.runs[0];
  assert.equal(run.groupedAnalysisExists, true);
  assert.equal(run.analysisFileExists, true);
  assert.equal(run.analysisFile, path.join(run.runDir, "final-analysis.md"));
  assert.ok(run.importedAt);
  const html = await (await fetch(hub.url + run.vaultUrl)).text();
  assert.ok(html.includes("&lt;script&gt;window.compromised"));
  assert.ok(!html.includes("<script>window.compromised"));
  const config = await hub.request("/api/config", undefined, "GET");
  assert.equal("vaultPath" in config.data, false);
  assert.equal(
    (await hub.request("/api/config", { vaultPath: source })).status,
    400,
  );
  const repeated = await hub.request(
    "/api/analysis/import",
    commitBody(await inspect(hub, source)),
  );
  assert.equal(repeated.data.unchanged, true);
  assert.equal(
    (
      await hub.request(
        "/api/analysis-run/output-dir",
        { ...target, runName },
        "DELETE",
      )
    ).status,
    200,
  );
  const retained = (await info(hub)).data.runs[0];
  assert.equal(retained.runDir, "");
  assert.equal(retained.groupedAnalysisExists, false);
  assert.equal(
    retained.analysisFile,
    path.join(
      hub.root,
      "current",
      "analysis",
      target.reportUuid,
      runName,
      "final-analysis.md",
    ),
  );
  assert.ok(fs.existsSync(retained.analysisFile));
  assert.equal(
    (
      await hub.request(
        "/api/analysis-run/analysis-file",
        { ...target, runName },
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal((await info(hub)).data.runs.length, 0);
  assert.equal(digest(source), original);
});

for (const final of [true, false]) {
  test(`archive imports preserve ${final ? "final" : "grouped fallback"} and leave Downloads untouched`, async (t) => {
    const { hub, source, runName } = await sourceFixture(t, final);
    const original = digest(source);
    assert.equal(
      (
        await hub.request(
          "/api/analysis/import",
          commitBody(await inspect(hub, source)),
        )
      ).status,
      200,
    );
    const archived = await hub.request("/api/archive", {
      reportPath: "/reports/current/fixture-report/index.html",
      reportUuid: target.reportUuid,
    });
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    const archivedInfo = await hub.request(
      "/api/report-info?reportId=" + archived.data.newName,
      undefined,
      "GET",
    );
    assert.equal(archivedInfo.data.canImport, false);
    const run = archivedInfo.data.runs[0];
    assert.equal(run.analysisFileExists, final);
    assert.equal(run.groupedAnalysisExists, !final);
    const file = final ? run.analysisFile : run.groupedAnalysisFile;
    assert.equal(
      file,
      path.join(
        hub.root,
        "archive",
        "analysis",
        target.reportUuid,
        runName,
        final ? "final-analysis.md" : "grouped-analysis.md",
      ),
    );
    const unsupported = await hub.request("/api/analysis/import/preview", {
      reportId: archived.data.newName,
      sourcePath: source,
    });
    assert.equal(unsupported.status, 400);
    assert.equal(
      (
        await hub.request("/api/delete", {
          reportPath: archived.data.newName
            ? `/reports/archive/${archived.data.newName}/index.html`
            : "",
          reportUuid: target.reportUuid,
        })
      ).status,
      200,
    );
    assert.equal(digest(source), original);
  });
}

test("legacy adoption is non-destructive and a deleted final is never resurrected from the old vault", async (t) => {
  const hub = await startHub(t, "browser");
  const original = (await info(hub)).data.runs[0];
  const body = fs.readFileSync(original.analysisFile, "utf8");
  const migrated = await hub.request("/api/analysis/reconcile", target);
  assert.equal(migrated.status, 200, JSON.stringify(migrated.data));
  const run = (await info(hub)).data.runs[0];
  assert.equal(run.analysisFile, path.join(run.runDir, "final-analysis.md"));
  assert.equal(fs.readFileSync(original.analysisFile, "utf8"), body);
  assert.equal(
    (
      await hub.request(
        "/api/analysis-run/analysis-file",
        { ...target, runName: run.runName },
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(
    (await hub.request("/api/analysis/reconcile", target)).status,
    200,
  );
  assert.equal((await info(hub)).data.runs[0].analysisFileExists, false);
  assert.equal(fs.readFileSync(original.analysisFile, "utf8"), body);
});

test("source changes, competing finals, traversal and wrong report evidence cannot replace existing data", async (t) => {
  const { hub, source, generated } = await sourceFixture(t);
  const preview = await inspect(hub, source);
  fs.appendFileSync(path.join(source, "final-analysis.md"), "\nChanged");
  assert.equal(
    (await hub.request("/api/analysis/import", commitBody(preview))).data.code,
    "ANALYSIS_CHANGED",
  );
  assert.ok(fs.existsSync(generated.data.runDir));
  fs.writeFileSync(
    path.join(source, path.basename(source) + ".md"),
    "Conflicting final",
  );
  assert.equal(
    (
      await hub.request("/api/analysis/import/preview", {
        ...target,
        sourcePath: source,
      })
    ).data.code,
    "ANALYSIS_REVIEW_REQUIRED",
  );
  fs.unlinkSync(path.join(source, path.basename(source) + ".md"));
  const manifestFile = path.join(source, "index.json");
  const manifest = fs.readFileSync(manifestFile, "utf8");
  const invalid = JSON.parse(manifest);
  invalid.failures[0].folder = "../outside";
  fs.writeFileSync(manifestFile, JSON.stringify(invalid));
  assert.notEqual(
    (
      await hub.request("/api/analysis/import/preview", {
        ...target,
        sourcePath: source,
      })
    ).status,
    200,
  );
  fs.writeFileSync(manifestFile, manifest);
  const report = new AdmZip();
  report.addFile(
    "report.json",
    Buffer.from(
      JSON.stringify({
        stats: { total: 1, ok: false },
        files: [
          {
            tests: [
              {
                title: "Different test",
                results: [
                  {
                    attachments: [
                      { name: "trace", path: "data/another-trace.zip" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ),
  );
  fs.writeFileSync(
    path.join(hub.reportRoot, "index.html"),
    `<template id="playwrightReportBase64">data:application/zip;base64,${report.toBuffer().toString("base64")}</template>`,
  );
  assert.equal(
    (
      await hub.request("/api/analysis/import/preview", {
        ...target,
        sourcePath: source,
      })
    ).data.code,
    "REPORT_MISMATCH",
  );
});

test("legacy imports normalize the final filename and keep unknown analysis dates separate from import time", async (t) => {
  const { hub, source } = await sourceFixture(t);
  const legacy = path.join(path.dirname(source), "run-legacyRandom");
  fs.renameSync(source, legacy);
  const resultPath = path.join(legacy, "analysis-result.json");
  const result = JSON.parse(fs.readFileSync(resultPath));
  result.schemaVersion = 1;
  for (const key of ["createdAt", "runId", "source", "environment", "region"])
    delete result[key];
  fs.writeFileSync(resultPath, JSON.stringify(result));
  fs.renameSync(
    path.join(legacy, "final-analysis.md"),
    path.join(legacy, "run-legacyRandom.md"),
  );
  fs.mkdirSync(path.join(legacy, "empty-companion-directory"));
  const before = digest(legacy);
  const preview = await inspect(hub, legacy);
  assert.equal(preview.createdAt, "");
  const response = await hub.request(
    "/api/analysis/import",
    commitBody(preview),
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.run.createdAt, "");
  assert.ok(response.data.run.importedAt);
  assert.ok(fs.existsSync(response.data.run.finalAnalysisPath));
  assert.equal(
    path.basename(response.data.run.finalAnalysisPath),
    "final-analysis.md",
  );
  assert.ok(
    fs
      .statSync(
        path.join(response.data.run.runDir, "empty-companion-directory"),
      )
      .isDirectory(),
  );
  assert.equal(digest(legacy), before);
  assert.equal(
    (
      await hub.request(
        "/api/analysis/import",
        commitBody(await inspect(hub, legacy)),
      )
    ).data.unchanged,
    true,
  );
});

for (const mode of ["transient", "permanent"]) {
  test(
    `Windows ${mode} import locks have bounded retries and preserve source data`,
    {
      skip: process.platform !== "win32",
    },
    async (t) => {
      const { hub, source } = await sourceFixture(t);
      const original = digest(source);
      const previous = (await info(hub)).data.runs;
      const marker = path.join(hub.root, `import-lock-${mode}`);
      fs.writeFileSync(marker, "0");
      const result = await hub.request(
        "/api/analysis/import",
        commitBody(await inspect(hub, source)),
      );
      const attempts = Number(fs.readFileSync(marker, "utf8"));
      if (mode === "transient") {
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.ok(
          attempts >= 3 && attempts <= 6,
          `Unexpected attempt count: ${attempts}`,
        );
      } else {
        assert.equal(result.status, 500, JSON.stringify(result.data));
        assert.equal(attempts, 6);
        assert.deepEqual((await info(hub)).data.runs, previous);
        const pending = await hub.request(
          "/api/analysis/import/recovery?reportId=fixture-report",
          undefined,
          "GET",
        );
        assert.deepEqual(pending.data.transactions, []);
      }
      assert.equal(digest(source), original);
    },
  );
}

for (const mode of ["rollback", "failed-rollback", "committed-cleanup"]) {
  test(`import ${mode} preserves recoverable data and releases its busy lock`, async (t) => {
    const { hub, source, generated } = await sourceFixture(t);
    const before = (await info(hub)).data.runs;
    const sourceHash = digest(source);
    if (mode === "committed-cleanup")
      fs.writeFileSync(path.join(hub.root, "import-cleanup-fail"), "");
    else fs.writeFileSync(path.join(hub.root, "import-db-fail"), "");
    if (mode === "failed-rollback")
      fs.writeFileSync(path.join(hub.root, "import-rollback-fail"), "");
    const failed = await hub.request(
      "/api/analysis/import",
      commitBody(await inspect(hub, source)),
    );
    assert.notEqual(failed.status, 200);
    const pending = await hub.request(
      "/api/analysis/import/recovery?reportId=fixture-report",
      undefined,
      "GET",
    );
    assert.equal(pending.status, 200);
    if (mode === "rollback") {
      assert.equal(pending.data.transactions.length, 0);
      assert.deepEqual((await info(hub)).data.runs, before);
      assert.ok(fs.existsSync(generated.data.runDir));
    } else {
      assert.equal(failed.data.code, "IMPORT_RECOVERY_REQUIRED");
      assert.equal(pending.data.transactions.length, 1);
      assert.equal(
        pending.data.transactions[0].committed,
        mode === "committed-cleanup",
      );
      const blocked = await hub.request("/api/archive", {
        reportPath: "/reports/current/fixture-report/index.html",
      });
      assert.equal(blocked.data.code, "IMPORT_RECOVERY_REQUIRED");
      assert.equal(
        (await hub.request("/api/config", { currentPath: hub.root })).status,
        409,
      );
      fs.unlinkSync(
        path.join(
          hub.root,
          mode === "failed-rollback"
            ? "import-rollback-fail"
            : "import-cleanup-fail",
        ),
      );
      const recovered = await hub.request("/api/analysis/import/recover", {
        ...target,
        transaction: pending.data.transactions[0].transaction,
      });
      assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
      if (mode === "failed-rollback")
        assert.deepEqual((await info(hub)).data.runs, before);
      else
        assert.equal((await info(hub)).data.runs[0].analysisFileExists, true);
    }
    assert.equal(digest(source), sourceHash);
    assert.equal(
      (await hub.request("/api/analysis/reconcile", target)).status,
      200,
    );
  });
}

test("interrupted publication is recovered from its journal after a new server process starts", async (t) => {
  const { fork } = require("node:child_process");
  const { once } = require("node:events");
  const cleanup = [];
  t.after(async () => {
    for (const dispose of cleanup) await dispose();
  });
  const { hub, source } = await sourceFixture({
    after: (dispose) => cleanup.push(dispose),
  });
  const before = (await info(hub)).data.runs;
  const preview = await inspect(hub, source);
  fs.writeFileSync(path.join(hub.root, "import-crash"), "");
  await assert.rejects(
    hub.request("/api/analysis/import", commitBody(preview)),
  );
  if (hub.child.exitCode === null) await once(hub.child, "exit");
  const child = fork(path.join(__dirname, "artifact-test-server.cjs"), [], {
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      ARTIFACT_TEST_ROOT: hub.root,
      PLAYWRIGHT_REPORTS_DB_PATH: hub.databasePath,
    },
  });
  cleanup.unshift(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  const [{ url }] = await once(child, "message");
  const pending = await (
    await fetch(url + "/api/analysis/import/recovery?reportId=fixture-report")
  ).json();
  assert.equal(pending.transactions.length, 1);
  const recovery = await fetch(url + "/api/analysis/import/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...target,
      transaction: pending.transactions[0].transaction,
    }),
  });
  assert.equal(recovery.status, 200, await recovery.text());
  const restored = await (
    await fetch(url + "/api/report-info?reportId=fixture-report")
  ).json();
  assert.deepEqual(restored.runs, before);
});

test("atomic final edits enforce versions, large body limits, and expose missing references for repair", async (t) => {
  const { hub, source, runName } = await sourceFixture(t);
  assert.equal(
    (
      await hub.request(
        "/api/analysis/import",
        commitBody(await inspect(hub, source)),
      )
    ).status,
    200,
  );
  const route = `/api/analysis-run/final?reportId=fixture-report&runName=${runName}`;
  const current = await (await fetch(hub.url + route)).text();
  const expectedVersion = crypto
    .createHash("sha256")
    .update(current)
    .digest("hex");
  assert.equal(
    (
      await hub.request(
        route,
        { content: "Stale", expectedVersion: "wrong" },
        "PUT",
      )
    ).status,
    409,
  );
  assert.equal(
    (await hub.request(route, { content: "Missing version" }, "PUT")).status,
    409,
  );
  const content = "Final ".repeat(30_000);
  const saved = await hub.request(route, { content, expectedVersion }, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(await (await fetch(hub.url + route)).text(), content);
  const oversized = await hub.request(
    route,
    { content: "x".repeat(16 * 1024 * 1024), expectedVersion },
    "PUT",
  );
  assert.equal(oversized.status, 413);
  fs.unlinkSync(saved.data.path);
  const unavailable = (await info(hub)).data;
  assert.ok(
    unavailable.analysisInventory.issues.some((issue) =>
      issue.includes("missing"),
    ),
  );
  const catalog = await hub.request(
    "/api/agent/reports/search",
    undefined,
    "GET",
  );
  assert.equal(catalog.status, 200);
  assert.ok(catalog.data.reports[0].analysisIssues.length);
  const list = await hub.request("/api/agent/vault/list", undefined, "GET");
  assert.equal(list.status, 200);
  assert.ok(list.data.issues.length);
  const cleared = await hub.request(
    "/api/analysis-run/analysis-file",
    { ...target, runName },
    "DELETE",
  );
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(
    (await hub.request("/api/analysis/reconcile", target)).status,
    200,
  );
});

test("string schemas, links and oversized metadata cannot be treated as legacy bundles", async (t) => {
  const { hub, source } = await sourceFixture(t);
  const resultPath = path.join(source, "analysis-result.json");
  const original = fs.readFileSync(resultPath);
  const result = JSON.parse(original);
  result.schemaVersion = "2";
  fs.writeFileSync(resultPath, JSON.stringify(result));
  assert.equal(
    (
      await hub.request("/api/analysis/import/preview", {
        ...target,
        sourcePath: source,
      })
    ).data.code,
    "INVALID_BUNDLE",
  );
  fs.writeFileSync(resultPath, Buffer.alloc(16 * 1024 * 1024 + 1, " "));
  assert.equal(
    (
      await hub.request("/api/analysis/import/preview", {
        ...target,
        sourcePath: source,
      })
    ).data.code,
    "IMPORT_LIMIT",
  );
  fs.writeFileSync(resultPath, original);
  for (const name of [
    "final-analysis.md",
    "grouped-analysis.md",
    "summary.md",
  ]) {
    const file = path.join(source, name);
    const content = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1, "x"));
    const rejected = await hub.request("/api/analysis/import/preview", {
      ...target,
      sourcePath: source,
    });
    assert.equal(rejected.data.code, "IMPORT_LIMIT", name);
    if (name === "final-analysis.md") {
      fs.truncateSync(file, 16 * 1024 * 1024);
      const boundary = await hub.request("/api/analysis/import/preview", {
        ...target,
        sourcePath: source,
      });
      assert.equal(boundary.status, 200, JSON.stringify(boundary.data));
    }
    fs.writeFileSync(file, content);
  }
  const link = path.join(source, "linked-evidence");
  fs.symlinkSync(
    hub.reportRoot,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.notEqual(
    (
      await hub.request("/api/analysis/import/preview", {
        ...target,
        sourcePath: source,
      })
    ).status,
    200,
  );
});

test("matching trace metadata verifies association and relative links resolve inside the managed bundle", async (t) => {
  const { hub, source, runName } = await sourceFixture(t);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(source, "index.json"), "utf8"),
  );
  const report = new AdmZip();
  report.addFile(
    "report.json",
    Buffer.from(
      JSON.stringify({
        stats: { total: manifest.count, ok: false },
        files: [
          {
            tests: manifest.failures.map((entry) => ({
              title: entry.testTitle,
              results: Array.from(
                { length: entry.retryIndex + 1 },
                (_, retry) => ({
                  attachments:
                    retry === entry.retryIndex
                      ? [{ name: "trace", path: `data/${entry.traceSha1}.zip` }]
                      : [],
                }),
              ),
            })),
          },
        ],
      }),
    ),
  );
  fs.writeFileSync(
    path.join(hub.reportRoot, "index.html"),
    `<template id="playwrightReportBase64">data:application/zip;base64,${report.toBuffer().toString("base64")}</template>`,
  );
  const relative = manifest.failures[0].folder + "/evidence.json";
  fs.appendFileSync(
    path.join(source, "final-analysis.md"),
    `\n[Evidence](${relative})\n[Missing](absent.md)\n[Anchor](#details)\n`,
  );
  const original = digest(source);
  const preview = await inspect(hub, source);
  assert.equal(preview.verified, true);
  assert.ok(
    preview.warnings.some((warning) =>
      warning.includes("Missing bundle-relative link: absent.md"),
    ),
  );
  const imported = await hub.request("/api/analysis/import", {
    ...commitBody(preview),
    confirmUnverified: false,
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const run = (await info(hub)).data.runs[0];
  const html = await (await fetch(hub.url + run.vaultUrl)).text();
  const link = new URL(
    relative,
    `${hub.url}/reports/current/tmp/analysis-${target.reportUuid}/${runName}/final-analysis.md`,
  );
  assert.ok(html.includes(`href="${link.pathname}"`));
  assert.ok(html.includes('href="#details"'));
  assert.equal((await (await fetch(link)).json()).schemaVersion, 4);
  assert.equal(
    (
      await hub.request(
        "/api/analysis-run/output-dir",
        { ...target, runName },
        "DELETE",
      )
    ).status,
    200,
  );
  assert.ok(
    (await (await fetch(hub.url + run.vaultUrl)).text()).includes(
      "Some evidence links may be unavailable",
    ),
  );
  assert.equal(digest(source), original);
});

test("direct final deletion migrates legacy storage without deleting the original note", async (t) => {
  const hub = await startHub(t, "browser");
  const original = (await info(hub)).data.runs[0];
  const text = fs.readFileSync(original.analysisFile, "utf8");
  const deleted = await hub.request(
    "/api/analysis-run/analysis-file",
    { ...target, runName: original.runName },
    "DELETE",
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal((await info(hub)).data.runs[0].analysisFileExists, false);
  assert.equal(fs.readFileSync(original.analysisFile, "utf8"), text);
});

test("legacy regeneration re-confirms migrated paths after successful auth preflight", async (t) => {
  const hub = await startHub(t, "browser");
  const original = (await info(hub)).data.runs[0];
  const body = { reportPath: "/reports/current/fixture-report/index.html" };
  const first = await hub.request("/api/failures", body);
  const migrated = await hub.request("/api/failures", {
    ...body,
    replaceRunId: first.data.runId,
    analysisVersion: first.data.inventory.version,
  });
  assert.equal(
    migrated.data.code,
    "ANALYSIS_REPLACEMENT_REQUIRED",
    JSON.stringify(migrated.data),
  );
  assert.ok(
    migrated.data.inventory.entries[0].notes[0].path.endsWith(
      "final-analysis.md",
    ),
  );
  const regenerated = await hub.request("/api/failures", {
    ...body,
    replaceRunId: migrated.data.runId,
    analysisVersion: migrated.data.inventory.version,
  });
  assert.equal(regenerated.status, 200, JSON.stringify(regenerated.data));
  assert.ok(fs.existsSync(original.analysisFile));
  assert.equal(fs.existsSync(original.runDir), false);
});

test("the same imported run name remains report-scoped and filename aliases reject ambiguity", async (t) => {
  const { hub, source, runName } = await sourceFixture(t);
  const firstImport = await hub.request(
    "/api/analysis/import",
    commitBody(await inspect(hub, source)),
  );
  assert.equal(firstImport.status, 200, JSON.stringify(firstImport.data));
  const directory = path.join(hub.root, "current", "second-report");
  fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(directory, "index.html"),
    "<title>Playwright Test Report</title>",
  );
  await hub.request("/api/reports", undefined, "GET");
  const second = (
    await hub.request(
      "/api/report-info?reportId=second-report",
      undefined,
      "GET",
    )
  ).data;
  const identity = { reportId: second.reportId, reportUuid: second.reportUuid };
  const preview = await hub.request("/api/analysis/import/preview", {
    ...identity,
    sourcePath: source,
  });

  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const imported = await hub.request("/api/analysis/import", {
    ...commitBody(preview.data),
    ...identity,
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const listed = (await hub.request("/api/agent/vault/list", undefined, "GET"))
    .data.files;
  assert.equal(listed.filter((file) => file.runName === runName).length, 2);
  for (const entry of listed)
    assert.equal((await fetch(hub.url + entry.url)).status, 200);
  assert.equal(
    (await fetch(hub.url + "/api/agent/vault/" + runName)).status,
    409,
  );
  assert.equal(
    (
      await hub.request("/api/delete", {
        reportPath: "/reports/current/second-report/index.html",
        reportUuid: second.reportUuid,
      })
    ).status,
    200,
  );
  assert.equal((await info(hub)).data.runs[0].analysisFileExists, true);
});
