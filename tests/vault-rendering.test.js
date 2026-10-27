const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { startHub } = require("./helpers/hub.cjs");

test("vault rendering preserves Markdown features and raw notes after dependency updates", async t => {
  const hub = await startHub(t);
  const markdown = [
    "# Analysis",
    "",
    "| Result | Count |",
    "| --- | --- |",
    "| Passed | 3 |",
    "",
    "https://example.com",
    "",
    "```json",
    '{"status":"passed"}',
    "```",
    "",
    "<details><summary>Evidence</summary>Details</details>",
    "",
    '"Quoted text" -- checked.',
  ].join("\n");
  const filename = path.join(hub.root, "vault", "dependency-fixture.md");
  fs.writeFileSync(filename, markdown);
  const response = await fetch(hub.url + "/vault/dependency-fixture");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<h1>Analysis<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<a href="https:\/\/example\.com">/);
  assert.match(html, /<code class="language-json">/);
  assert.match(html, /<details><summary>Evidence<\/summary>Details<\/details>/);
  assert.match(html, /\u201cQuoted text\u201d \u2013 checked/);
  assert.equal(await (await fetch(hub.url + "/api/vault/dependency-fixture/raw")).text(), markdown);
  assert.equal(fs.readFileSync(filename, "utf8"), markdown);
});
