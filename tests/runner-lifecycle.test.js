const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter, once } = require("node:events");
const { PassThrough } = require("node:stream");
const cp = require("node:child_process");
const test = require("node:test");
const express = require("express");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "reports-runner-test-"));
process.env.PLAYWRIGHT_REPORTS_DB_PATH = path.join(root, "app.db");
const store = require("../dist/db");
store.updateConfig({ ...store.getConfig(), projectPath: root });
const runtime = require("../dist/runtime");
const configs = require("../dist/runner-configs");
const killPath = require.resolve("tree-kill");
require(killPath);
const stopped = [];
let killError;
require.cache[killPath].exports = (pid, _signal, callback) => {
  stopped.push(pid);
  callback(killError);
};
const { registerRunnerRoutes } = require("../dist/runner-routes");
const app = express();
app.use(express.json());
registerRunnerRoutes(app);
const server = app.listen(0, "127.0.0.1");
test.after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

async function setup(t) {
  if (!server.listening) await once(server, "listening");
  stopped.length = 0;
  killError = undefined;
  const children = [];
  const logs = [];
  t.mock.method(cp, "spawn", () => {
    const child = new EventEmitter();
    child.pid = 900000 + children.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    children.push(child);
    return child;
  });
  t.mock.method(runtime, "broadcastLog", (type, data) => logs.push({ type, data }));
  t.mock.method(configs, "discoverRunnerConfigs", async () => ({
    playwrightConfigs: ["playwright.config.ts"],
    browserstackConfigs: [],
  }));
  fs.writeFileSync(path.join(root, "playwright.config.ts"), "export default {};");
  t.after(() => children.forEach(child => child.emit("close", 0)));
  const request = async (endpoint = "/api/run-tests", body = { playwrightConfig: "playwright.config.ts", args: [] }) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, data: await response.json() };
  };
  return { children, logs, request };
}

test("reserves runner ownership while discovering configuration", async t => {
  const { children, request } = await setup(t);
  let release;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  configs.discoverRunnerConfigs = () => {
    entered();
    return new Promise(resolve => { release = () => resolve({ playwrightConfigs: ["playwright.config.ts"], browserstackConfigs: [] }); });
  };
  const first = request();
  try {
    await waiting;
    assert.equal((await request()).status, 409);
    assert.equal((await request("/api/stop-tests")).status, 409);
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal(children.length, 1);
  assert.equal((await request("/api/stop-tests")).status, 200);
  assert.deepEqual(stopped, [children[0].pid]);
});

test("late completion of a replaced process cannot complete the new run", async t => {
  const { children, logs, request } = await setup(t);
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 200);
  const count = logs.filter(log => log.type === "complete").length;
  children[0].emit("close", null);
  assert.equal(logs.filter(log => log.type === "complete").length, count);
  assert.equal((await request("/api/stop-tests")).status, 200);
  assert.deepEqual(stopped, [children[0].pid, children[1].pid]);
});

test("invalid replacement requests do not stop a working run and stop errors remain visible", async t => {
  const { children, request } = await setup(t);
  await request();
  assert.equal((await request("/api/run-tests", { args: [1] })).status, 400);
  assert.deepEqual(stopped, []);
  killError = new Error("fixture stop failed");
  assert.equal((await request("/api/stop-tests")).status, 500);
  killError = undefined;
  assert.equal((await request("/api/stop-tests")).status, 200);
  assert.deepEqual(stopped, [children[0].pid, children[0].pid]);
});

test("spawn failure cleans temporary headless config and emits completion only once", async t => {
  const { children, logs, request } = await setup(t);
  await request("/api/run-tests", { playwrightConfig: "playwright.config.ts", args: [], headless: true });
  assert.equal(fs.readdirSync(root).filter(name => name.startsWith(".pw-reports-headless-")).length, 1);
  children[0].emit("error", new Error("fixture spawn failed"));
  children[0].emit("close", -1);
  assert.equal(fs.readdirSync(root).filter(name => name.startsWith(".pw-reports-headless-")).length, 0);
  assert.equal(logs.filter(log => log.type === "complete").length, 1);
});
