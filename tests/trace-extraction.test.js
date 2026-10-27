const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const test = require("node:test");
const AdmZip = require("adm-zip");
const { extractReportTraces } = require("../dist/trace-extraction");
const { withReportPreparation, PREPARATION_WORKERS } = require("../dist/report-preparation");

function fixture(t, count = 12) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reports-extraction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < count; index++) {
    const zip = new AdmZip();
    zip.addFile("test.trace", Buffer.from(`trace ${index}\n`));
    zip.addFile("resources/body.json", Buffer.from(JSON.stringify({ index })));
    zip.writeZip(path.join(root, `trace-${index}.zip`));
  }
  return root;
}

function monitor(t) {
  const originalFork = cp.fork;
  const children = [];
  const active = new Set();
  const counts = new Map();
  let maxActive = 0;
  t.mock.method(cp, "fork", (...args) => {
    const child = originalFork(...args);
    children.push(child);
    const send = child.send.bind(child);
    t.mock.method(child, "send", (...sendArgs) => {
      assert.equal(active.has(child), false);
      active.add(child);
      maxActive = Math.max(maxActive, active.size);
      counts.set(child, (counts.get(child) || 0) + 1);
      return send(...sendArgs);
    });
    child.on("message", () => active.delete(child));
    child.on("exit", () => active.delete(child));
    return child;
  });
  return {
    children,
    counts,
    max: () => maxActive,
    closed: () => {
      assert.equal(active.size, 0);
      assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
      assert.ok(children.every(child => !child.connected));
    },
  };
}

function assertNoStaging(root) {
  assert.ok(!fs.readdirSync(root).some(name => name.startsWith(".extract-")));
}

test("raw extraction uses four reusable processes and publishes byte-identical complete folders", async t => {
  const root = fixture(t);
  const workers = monitor(t);
  const progress = [];
  const before = fs.readdirSync(root).map(name => [name, fs.readFileSync(path.join(root, name))]);
  assert.equal(await extractReportTraces(root, { onProgress: value => progress.push(value) }), 12);
  assert.equal(workers.children.length, PREPARATION_WORKERS);
  assert.equal(workers.max(), 4);
  assert.ok([...workers.counts.values()].some(count => count > 1));
  workers.closed();
  for (let index = 0; index < 12; index++) {
    const zip = new AdmZip(path.join(root, `trace-${index}.zip`));
    for (const entry of zip.getEntries())
      assert.deepEqual(fs.readFileSync(path.join(root, `trace-${index}`, entry.entryName)), entry.getData());
  }
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes);
  assert.deepEqual(progress.map(value => value.completed), Array.from({ length: 13 }, (_, index) => index));
  assert.ok(progress.every(value => value.total === 12));
  assertNoStaging(root);
  assert.equal(await extractReportTraces(root), 0);
  assert.equal(workers.children.length, 4);
});

test("existing extraction directories and non-ZIP files stay unchanged", async t => {
  const root = fixture(t, 2);
  fs.mkdirSync(path.join(root, "trace-0"));
  fs.writeFileSync(path.join(root, "trace-0", "keep.txt"), "existing extraction");
  fs.writeFileSync(path.join(root, "notes.md"), "keep");
  const workers = monitor(t);
  assert.equal(await extractReportTraces(root), 1);
  assert.equal(workers.children.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, "trace-0")), ["keep.txt"]);
  assert.equal(fs.readFileSync(path.join(root, "notes.md"), "utf8"), "keep");
  workers.closed();
});

test("500 archives still use only four reusable workers", async t => {
  const root = fixture(t, 500);
  const workers = monitor(t);
  assert.equal(await extractReportTraces(root), 500);
  assert.equal(workers.children.length, 4);
  assert.equal(workers.max(), 4);
  assert.equal([...workers.counts.values()].reduce((sum, count) => sum + count, 0), 500);
  for (let index = 0; index < 500; index++)
    assert.equal(fs.readFileSync(path.join(root, `trace-${index}`, "test.trace"), "utf8"), `trace ${index}\n`);
  assertNoStaging(root);
  workers.closed();
});

test("no archives means no worker process", async t => {
  const root = fixture(t, 0);
  const workers = monitor(t);
  assert.equal(await extractReportTraces(root), 0);
  assert.equal(workers.children.length, 0);
  assertNoStaging(root);
});

test("corrupt archives surface an error, drain workers, and leave no partial final directory", async t => {
  const root = fixture(t);
  const workers = monitor(t);
  fs.writeFileSync(path.join(root, "trace-0.zip"), "invalid zip");
  await assert.rejects(extractReportTraces(root), /trace-0.zip/);
  workers.closed();
  assertNoStaging(root);
  assert.equal(fs.existsSync(path.join(root, "trace-0")), false);
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    assert.ok(fs.existsSync(path.join(root, entry.name, "test.trace")));
    assert.ok(fs.existsSync(path.join(root, entry.name, "resources", "body.json")));
  }
  const zip = new AdmZip();
  zip.addFile("test.trace", Buffer.from("fixed"));
  zip.writeZip(path.join(root, "trace-0.zip"));
  await extractReportTraces(root);
  assert.equal(fs.readFileSync(path.join(root, "trace-0", "test.trace"), "utf8"), "fixed");
  assertNoStaging(root);
  workers.closed();
});

test("report identity changes prevent publication and still clean staging", async t => {
  const root = fixture(t);
  const workers = monitor(t);
  await assert.rejects(extractReportTraces(root, {
    beforePublish: () => { throw new Error("Report replaced"); },
  }), /Report replaced/);
  workers.closed();
  assertNoStaging(root);
  assert.ok(fs.readdirSync(root).every(name => name.endsWith(".zip")));
});

test("unexpected worker exits reject rather than hanging or publishing incomplete files", async t => {
  const root = fixture(t);
  const workers = monitor(t);
  const operation = extractReportTraces(root, {
    onProgress: ({ completed }) => {
      if (completed === 1) workers.children.find(child => child.exitCode === null)?.kill("SIGTERM");
    },
  });
  await assert.rejects(operation, /worker exited|EPIPE|closed/i);
  workers.closed();
  assertNoStaging(root);
});

for (const mode of ["sync", "async"]) {
  test(`${mode} worker startup failures release staging`, { timeout: 10000 }, async t => {
    const root = fixture(t, 1);
    const originalFork = cp.fork;
    t.mock.method(cp, "fork", (...args) => {
      if (mode === "sync") throw new Error("Synthetic fork failure");
      return originalFork(args[0], args[1], { ...args[2], execPath: path.join(root, "missing-node") });
    });
    await assert.rejects(extractReportTraces(root), /fork failure|ENOENT/);
    assertNoStaging(root);
  });
}

test("the shared queue is FIFO, releases on failure, and never exceeds four extraction workers", async t => {
  const left = fixture(t);
  const right = fixture(t);
  const workers = monitor(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const order = [];
  const first = withReportPreparation(async () => {
    order.push("held");
    await held;
    throw new Error("Synthetic preparation failure");
  });
  const expectedFailure = assert.rejects(first, /preparation failure/);
  const second = withReportPreparation(async () => { order.push("left"); return extractReportTraces(left); });
  const third = withReportPreparation(async () => { order.push("right"); return extractReportTraces(right); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["held"]);
  assert.equal(workers.children.length, 0);
  release();
  await expectedFailure;
  assert.deepEqual(await Promise.all([second, third]), [12, 12]);
  assert.deepEqual(order, ["held", "left", "right"]);
  assert.equal(workers.max(), 4);
  workers.closed();
});
