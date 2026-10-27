const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");

async function startHub(context, seed = "", extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reports-test-hub-"));
  const databasePath = path.join(root, "app.db");
  const child = fork(path.join(__dirname, "../artifact-test-server.cjs"), [], {
    cwd: path.join(__dirname, "../.."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      ...extraEnv,
      ARTIFACT_TEST_ROOT: root,
      ARTIFACT_TEST_SEED: seed,
      ARTIFACT_TEST_PORT: "0",
      PLAYWRIGHT_REPORTS_DB_PATH: databasePath,
    },
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  context.after(dispose);
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Hub startup timed out: " + stderr)), 10000);
    const onExit = () => finish(new Error("Hub exited before startup: " + stderr));
    const onMessage = message => { if (message.url) finish(null, message); };
    const finish = (error, message) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("message", onMessage);
      child.removeListener("error", finish);
      if (error) reject(error); else resolve(message);
    };
    child.once("error", finish);
    child.once("exit", onExit);
    child.on("message", onMessage);
  }).catch(async error => {
    await dispose();
    throw error;
  });
  async function request(endpoint, body, method = "POST") {
    const response = await fetch(ready.url + endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, data: await response.json() };
  }
  return { ...ready, root, databasePath, child, request };
}

module.exports = { startHub };
