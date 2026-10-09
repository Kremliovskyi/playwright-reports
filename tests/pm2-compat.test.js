const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const pm2Require = createRequire(require.resolve("pm2/package.json"));

test("PM2 dependency overrides retain YAML and FTP client APIs", () => {
  const yaml = pm2Require("js-yaml");
  assert.deepEqual(yaml.load("apps:\n  - name: fixture\n    watch: false\n"), {
    apps: [{ name: "fixture", watch: false }]
  });
  const proxyRequire = createRequire(pm2Require.resolve("proxy-agent"));
  const pacRequire = createRequire(proxyRequire.resolve("pac-proxy-agent"));
  const uriRequire = createRequire(pacRequire.resolve("get-uri"));
  const { Client } = uriRequire("basic-ftp");
  const client = new Client();
  try {
    for (const method of ["access", "lastMod", "list", "downloadTo", "close"])
      assert.equal(typeof client[method], "function", method);
  } finally {
    client.close();
  }
});

test(
  "PM2 watcher supports literal directories and restart callbacks",
  { timeout: 10000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pm2-watch-compat-"));
    const source = path.join(root, "watched.txt");
    let restarted;
    const restart = new Promise((resolve) => {
      restarted = resolve;
    });
    const manager = {
      restartProcessName(name, callback) {
        callback(null, []);
        restarted(name);
      }
    };
    require("pm2/lib/Watcher")(manager);
    try {
      await fs.writeFile(source, "before");
      manager.watch.enable({
        pm_id: 0,
        name: "fixture",
        watch: [root],
        pm_cwd: root
      });
      const watcher = manager.watch._watchers[0];
      await once(watcher, "ready");
      await fs.writeFile(source, "after");
      assert.equal(await restart, "fixture");
    } finally {
      await manager.watch._watchers[0]?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

test(
  "PM2 starts and restarts a process in an isolated home",
  { timeout: 60000 },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "pm2-process-compat-")
    );
    const script = path.join(root, "fixture.cjs");
    const cli = require.resolve("pm2/bin/pm2");
    const invoke = (...args) => {
      const result = spawnSync(process.execPath, [cli, ...args], {
        env: { ...process.env, PM2_HOME: path.join(root, "home") },
        encoding: "utf8",
        timeout: 20000
      });
      assert.equal(
        result.status,
        0,
        `${args[0]}: ${result.error || result.stderr}`
      );
      return result.stdout;
    };
    try {
      await fs.writeFile(
        script,
        'require("node:http").createServer().listen(0, "127.0.0.1");'
      );
      invoke(
        "start",
        script,
        "--name",
        "dependency-fixture",
        "--no-autorestart"
      );
      const [initial] = JSON.parse(invoke("jlist"));
      assert.equal(initial.name, "dependency-fixture");
      assert.equal(initial.pm2_env.status, "online");
      invoke("restart", "dependency-fixture");
      const [restarted] = JSON.parse(invoke("jlist"));
      assert.equal(restarted.pm2_env.status, "online");
      assert.notEqual(restarted.pid, initial.pid);
    } finally {
      invoke("kill");
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
