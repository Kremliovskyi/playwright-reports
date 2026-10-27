const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadPlaywrightConfigProjection,
} = require("../dist/playwright-config-loader");

const createConfig = (t, source) => {
  const projectPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "playwright-config-loader-"),
  );
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  const configPath = path.join(projectPath, "playwright.config.ts");
  fs.writeFileSync(configPath, source);
  return { configPath, projectPath };
};

test("loads a serializable projection while ignoring config output", async (t) => {
  const { configPath, projectPath } = createConfig(
    t,
    `
      console.log("config output");
      export default {
        projects: [{ name: "chromium" }, { name: "" }, { name: "webkit" }],
        expect: {
          toMatchAriaSnapshot: {
            pathTemplate: "snapshots/{testFilePath}/{arg}{ext}",
          },
        },
      };
    `,
  );

  assert.deepEqual(
    await loadPlaywrightConfigProjection(configPath, { cwd: projectPath }),
    {
      projectNames: ["chromium", "webkit"],
      ariaSnapshotPathTemplate: "snapshots/{testFilePath}/{arg}{ext}",
    },
  );
});

test("propagates config evaluation errors", async (t) => {
  const { configPath } = createConfig(
    t,
    `throw new Error("invalid project config");`,
  );

  await assert.rejects(
    loadPlaywrightConfigProjection(configPath),
    /invalid project config/,
  );
});

test("isolates process globals between sequential config loads", async (t) => {
  const first = createConfig(
    t,
    `
      if ((globalThis as any).__playwrightConfigLoaded)
        throw new Error("shared config state");
      (globalThis as any).__playwrightConfigLoaded = true;
      export default { projects: [{ name: "first" }] };
    `,
  );
  const second = createConfig(
    t,
    `
      if ((globalThis as any).__playwrightConfigLoaded)
        throw new Error("shared config state");
      (globalThis as any).__playwrightConfigLoaded = true;
      export default { projects: [{ name: "second" }] };
    `,
  );

  assert.deepEqual(
    (await loadPlaywrightConfigProjection(first.configPath)).projectNames,
    ["first"],
  );
  assert.deepEqual(
    (await loadPlaywrightConfigProjection(second.configPath)).projectNames,
    ["second"],
  );
});

for (const fails of [false, true]) {
  test(`terminates config-created handles before ${fails ? "rejecting" : "resolving"}`, async t => {
    const { configPath, projectPath } = createConfig(t, `
      import fs from "node:fs";
      fs.writeFileSync("loader.pid", String(process.pid));
      setInterval(() => {}, 1000);
      ${fails ? 'throw new Error("fixture failure");' : 'export default { projects: [{ name: "timer" }] };'}
    `);
    const loaded = loadPlaywrightConfigProjection(configPath, { cwd: projectPath });
    if (fails) await assert.rejects(loaded, /fixture failure/);
    else assert.deepEqual((await loaded).projectNames, ["timer"]);
    const pid = Number(fs.readFileSync(path.join(projectPath, "loader.pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("times out and terminates a config that never finishes evaluation", async t => {
  const { configPath } = createConfig(t, "while (true) {}");
  await assert.rejects(loadPlaywrightConfigProjection(configPath, { timeoutMs: 100 }), /Timed out/);
});
