const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { startHub } = require("./helpers/hub.cjs");

test("archive limit persists and rejects invalid settings without changing config", async t => {
  const hub = await startHub(t);
  const initial = await hub.request("/api/config", undefined, "GET");
  assert.equal(initial.data.archiveLimit, 20);
  for (const archiveLimit of [1, 37]) {
    const saved = await hub.request("/api/config", { archiveLimit });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.config.archiveLimit, archiveLimit);
  }
  const partial = await hub.request("/api/config", { copilotModel: "saved-model" });
  assert.equal(partial.data.config.archiveLimit, 37);
  const database = new Database(hub.databasePath, { readonly: true });
  try {
    assert.equal(database.prepare("SELECT archiveLimit FROM config WHERE id = 'default'").get().archiveLimit, 37);
  } finally {
    database.close();
  }
  for (const archiveLimit of [0, -1, 1.5, "30", "", null, true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    const rejected = await hub.request("/api/config", { archiveLimit, copilotModel: "must-not-save" });
    assert.equal(rejected.status, 400, JSON.stringify(archiveLimit));
    assert.match(rejected.data.error, /Archived report limit must be a positive whole number/);
    const config = await hub.request("/api/config", undefined, "GET");
    assert.equal(config.data.archiveLimit, 37);
    assert.equal(config.data.copilotModel, "saved-model");
  }
});

test("existing databases gain the default archive limit and retain edits after reopening", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reports-config-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "app.db");
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE config (
        id TEXT PRIMARY KEY,
        currentPath TEXT NOT NULL DEFAULT '',
        archivePath TEXT NOT NULL DEFAULT '',
        projectPath TEXT NOT NULL DEFAULT '',
        runnerOptions TEXT NOT NULL DEFAULT '{}',
        selectedProjects TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO config (id, currentPath) VALUES ('default', '/existing/reports');
    `);
  } finally {
    database.close();
  }
  const run = script => execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PLAYWRIGHT_REPORTS_DB_PATH: databasePath },
  });
  run(`
    const assert = require("node:assert/strict");
    const store = require("./dist/db");
    const config = store.getConfig();
    assert.equal(config.archiveLimit, 20);
    assert.equal(config.currentPath, "/existing/reports");
    store.updateConfig({ ...config, archiveLimit: 37 });
  `);
  run(`
    const assert = require("node:assert/strict");
    const config = require("./dist/db").getConfig();
    assert.equal(config.archiveLimit, 37);
    assert.equal(config.currentPath, "/existing/reports");
  `);
});
