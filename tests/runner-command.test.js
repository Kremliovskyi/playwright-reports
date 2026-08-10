const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatRunnerArgs,
  prepareRunnerArgs,
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
