const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({ document: { addEventListener() {} } });
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "../dist/public/runner.js"), "utf8"),
  context,
);
const { normalizeRunnerTitles, buildRunnerGrep } = vm.runInContext(
  "({ normalizeRunnerTitles, buildRunnerGrep })",
  context,
);

test("normalizes multiline titles, trims whitespace and removes duplicates", () => {
  assert.deepEqual(
    Array.from(normalizeRunnerTitles([
      " login \r\nreset password\n\ncheckout\rlogin ",
      "checkout",
      " ",
    ])),
    ["login", "reset password", "checkout"],
  );
});

test("preserves spaces, commas, pipes, casing and non-ASCII titles", () => {
  const titles = ["login, admin | guest", "Login", "login", "\u767b\u5f55"];
  assert.deepEqual(Array.from(normalizeRunnerTitles(titles)), titles);
});

test("persisted entries round-trip without turning a legacy pipe into OR", () => {
  const titles = ["legacy|filter", "second title", 'login "admin"'];
  const saved = titles.join("\n");
  assert.deepEqual(Array.from(normalizeRunnerTitles([saved])), titles);
  const legacy = new RegExp(buildRunnerGrep(["legacy|filter"]));
  assert.ok(legacy.test("suite legacy|filter"));
  assert.ok(!legacy.test("suite legacy"));
  assert.ok(!legacy.test("suite filter"));
});

test("builds a single OR pattern with literal substring matching", () => {
  const pattern = buildRunnerGrep(["login", "reset password", "checkout"]);
  assert.equal(pattern, "login|reset password|checkout");
  const grep = new RegExp(pattern);
  for (const title of [
    "chromium auth.spec.ts login as admin",
    "suite reset password successfully",
    "checkout with card",
  ]) assert.ok(grep.test(title), title);
  assert.ok(!grep.test("unrelated test"));
  assert.ok(!grep.test("Login"));
});

test("escapes each title before joining so regex punctuation stays literal", () => {
  const title = "a.b*+?^${}()|[]\\";
  const pattern = buildRunnerGrep([title, "login (admin)"]);
  const grep = new RegExp(pattern);
  assert.ok(grep.test(`suite ${title} succeeds`));
  assert.ok(grep.test("login (admin)"));
  assert.ok(!grep.test("login admin"));
  assert.ok(!grep.test("anything else"));
});

test("matches double quotes exactly without literal quotes in shell arguments", () => {
  const pattern = buildRunnerGrep(['login "admin"', 'literal \\x22', "checkout"]);
  assert.ok(!pattern.includes('"'));
  const grep = new RegExp(pattern);
  assert.ok(grep.test('login "admin"'));
  assert.ok(!grep.test("login XadminY"));
  assert.ok(grep.test("literal \\x22"));
  assert.ok(!grep.test('literal "'));
  assert.ok(grep.test("checkout"));
});

test("blank entries never introduce an empty alternative", () => {
  assert.equal(buildRunnerGrep([]), "");
  assert.equal(buildRunnerGrep([" ", "\r\n"]), "");
  assert.equal(buildRunnerGrep([" ", " login ", "", "login", "\n"]), "login");
  assert.ok(!new RegExp(buildRunnerGrep(["", "login"])).test("unrelated"));
});
