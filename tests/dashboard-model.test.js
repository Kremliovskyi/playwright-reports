const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { startHub } = require("./helpers/hub.cjs");

const context = vm.createContext({ URLSearchParams });
for (const file of ["dashboard-model", "aria-diff", "api"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, `../dist/public/${file}.js`), "utf8"), context);
const model = context.DashboardModel;

test("report targets retain the identity captured before a refresh or confirmation", () => {
  const targets = new model.ReportTargets();
  targets.remember({ path: "/report", uuid: "old" });
  const pending = targets.get("/report");
  targets.remember({ path: "/report", uuid: "new" });
  assert.equal(pending.reportUuid, "old");
  assert.equal(targets.get("/report").reportUuid, "new");
  assert.throws(() => targets.get("/missing"), /identity is unavailable/);
});

test("search models preserve explicit date bounds and encode literal metadata", () => {
  const filters = model.normalizeSearchFilters({ query: " UAT & EU ", rangeStart: "2026-01-01", rangeEnd: "" });
  assert.equal(model.buildSearchUrl(filters), "/api/report-search?query=UAT+%26+EU&rangeStart=2026-01-01");
  assert.equal(model.hasSearchFilters(model.createEmptySearchFilters()), false);
});

test("ARIA diff ignores the deep-equal prefix and normalizes line endings", () => {
  const diff = context.AriaDiff.computeDiff("- /children: deep-equal\r\n- heading Before", "- heading After");
  assert.equal(diff.length, 2);
  assert.equal(diff.find(line => line.type === "removed").text, "- heading Before");
  assert.equal(diff.find(line => line.type === "added").text, "- heading After");
});

test("API helper rejects HTTP failures and HTML success fallbacks", async () => {
  context.fetch = async () => ({ ok: false, status: 500, headers: new Headers({ "Content-Type": "application/json" }), json: async () => ({ error: "save failed" }) });
  await assert.rejects(context.Api.save("/api/config", {}), /save failed/);
  context.fetch = async () => ({ ok: true, status: 200, headers: new Headers({ "Content-Type": "text/html" }) });
  await assert.rejects(context.Api.json("/api/config"), /Expected JSON/);
});

test("unknown API endpoints return JSON 404 while page routes retain their fallback", async t => {
  const hub = await startHub(t);
  const api = await hub.request("/api/not-an-endpoint", undefined, "GET");
  assert.equal(api.status, 404);
  assert.match(api.data.error, /Unknown API endpoint/);
  const page = await fetch(hub.url + "/runner");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
});
