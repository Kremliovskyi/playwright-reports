const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  discoverRunnerConfigs,
  resolveDiscoveredConfig,
} = require("../dist/runner-configs");

const writeFile = (root, relativePath) => {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
};

test("discovers and sorts runner configs under the project path", async (t) => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "runner-configs-"));
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));

  for (const relativePath of [
    "playwright.config.ts",
    "configs/playwright.api.config.cts",
    ".config/playwright.hidden.config.mjs",
    "nested/deeper/playwright.e2e.config.cjs",
    "browserstack.yml",
    "configs/browserstack.mobile.yaml",
    "node_modules/package/playwright.config.js",
    "node_modules/package/browserstack.yml",
    "test-results/run/playwright.config.ts",
    "test-results/run/browserstack.yml",
    ".playwright-reports-headless-test.config.cjs",
    ".pw-reports-headless-test.config.cjs",
  ])
    writeFile(projectPath, relativePath);

  fs.mkdirSync(path.join(projectPath, "playwright.directory.config.ts"));

  const configs = await discoverRunnerConfigs(projectPath);

  assert.deepEqual(configs.playwrightConfigs, [
    "playwright.config.ts",
    "configs/playwright.api.config.cts",
    ".config/playwright.hidden.config.mjs",
    "nested/deeper/playwright.e2e.config.cjs",
  ]);
  assert.deepEqual(configs.browserstackConfigs, [
    "browserstack.yml",
    "configs/browserstack.mobile.yaml",
  ]);
});

test("resolves only discovered configs inside the project path", (t) => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "runner-configs-"));
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  writeFile(projectPath, "..ci/playwright.config.ts");

  assert.equal(
    resolveDiscoveredConfig(
      projectPath,
      "..ci\\playwright.config.ts",
      ["..ci/playwright.config.ts"],
      "Playwright config",
    ),
    path.join(projectPath, "..ci", "playwright.config.ts"),
  );
  assert.throws(
    () =>
      resolveDiscoveredConfig(
        projectPath,
        "missing/playwright.config.ts",
        ["..ci/playwright.config.ts"],
        "Playwright config",
      ),
    /is not available under the project path/,
  );
  assert.throws(
    () =>
      resolveDiscoveredConfig(
        projectPath,
        "../playwright.config.ts",
        ["../playwright.config.ts"],
        "Playwright config",
      ),
    /must be inside the project path/,
  );
});
