const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildPodmanArgs,
  formatRunnerArgs,
  prepareRunnerArgs,
  resolvePodmanImage,
  resolvePodmanExecutable,
} = require("../dist/runner-command");

test("keeps a multiword grep as one unquoted POSIX argument", () => {
  const args = ["--grep", "should complete multiple todos", "--headed"];

  assert.deepEqual(prepareRunnerArgs(args, "darwin"), args);
  assert.deepEqual(prepareRunnerArgs(args, "linux"), args);
  assert.equal(args[1], "should complete multiple todos");
});

test("quotes a multiword grep for the Windows shell", () => {
  assert.deepEqual(
    prepareRunnerArgs(
      ["--project", "chromium", "--grep", "should complete multiple todos"],
      "win32",
    ),
    ["--project", "chromium", "--grep", '"should complete multiple todos"'],
  );
});

test("formats whitespace for display without changing execution arguments", () => {
  const args = [
    "--grep",
    "should complete multiple todos",
    "--config",
    "config path.ts",
  ];

  assert.equal(
    formatRunnerArgs(args),
    '--grep "should complete multiple todos" --config "config path.ts"',
  );
  assert.deepEqual(args, [
    "--grep",
    "should complete multiple todos",
    "--config",
    "config path.ts",
  ]);
});

test("Podman isolates dependencies and preserves Windows paths and test arguments", () => {
  const args = ["--grep", "a multiword test", "--config", "configs/test config.ts", "--update-snapshots"];
  const result = buildPodmanArgs({
    projectPath: "D:\\Test Projects\\suite",
    image: "mcr.microsoft.com/playwright:v1.59.0-noble",
    containerName: "runner-test",
    args,
    env: { ENV: "UAT", SECRET: "not-for-command-logs" },
  });
  assert.ok(result.includes("D:\\Test Projects\\suite:/work:Z"));
  assert.ok(result.includes("/work/node_modules"));
  assert.ok(result.includes("--pull=never"));
  assert.ok(result.includes('npm ci --include=dev && exec npx playwright test "$@"'));
  assert.deepEqual(result.slice(-args.length), args);
  assert.ok(result.includes("SECRET"));
  assert.ok(!result.includes("not-for-command-logs"));
  assert.ok(result.includes("PLAYWRIGHT_HTML_OPEN=never"));
});

test("Podman rejects malformed environment variable names", () => {
  assert.throws(() => buildPodmanArgs({
    projectPath: "/tests", image: "image", containerName: "test", args: [],
    env: { "BAD=NAME": "value" },
  }), /Invalid environment variable name/);
});

test("Podman pins its image to the npm lockfile used inside the container", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-podman-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => resolvePodmanImage(root), /require an npm lockfile/);
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
    packages: { "node_modules/playwright": { version: "1.59.0" } },
  }));
  assert.equal(resolvePodmanImage(root), "mcr.microsoft.com/playwright:v1.59.0-noble");
  fs.writeFileSync(path.join(root, "npm-shrinkwrap.json"), JSON.stringify({
    dependencies: { "@playwright/test": { version: "1.58.2" } },
  }));
  assert.equal(resolvePodmanImage(root), "mcr.microsoft.com/playwright:v1.58.2-noble");
  fs.writeFileSync(path.join(root, "npm-shrinkwrap.json"), JSON.stringify({
    packages: { "node_modules/playwright": { version: "1.60.0-alpha" } },
  }));
  assert.throws(() => resolvePodmanImage(root), /stable Playwright version/);
});

test("finds a standard Windows Podman installation when PATH is stale", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "podman-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installDir = path.join(root, "Programs", "Podman");
  fs.mkdirSync(installDir, { recursive: true });
  const executable = path.join(installDir, "podman.exe");
  fs.writeFileSync(executable, "");
  assert.equal(resolvePodmanExecutable("win32", { LOCALAPPDATA: root }), executable);
  assert.equal(resolvePodmanExecutable("linux", { LOCALAPPDATA: root }), "podman");
  fs.writeFileSync(path.join(root, "podman.exe"), "");
  assert.equal(resolvePodmanExecutable("win32", { PATH: root, LOCALAPPDATA: root }), path.join(root, "podman.exe"));
});
