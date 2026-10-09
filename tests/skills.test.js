const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const cli = path.resolve(__dirname, "../dist/cli.js");
const run = (...args) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("skill installer copies packaged templates, keeps local edits and supports explicit replacement", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "reports-skills-"));
  try {
    const result = run("init-skills", target);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.command, "init-skills");
    const templates = path.resolve(__dirname, "../templates/skills");
    assert.deepEqual(
      payload.skills.map((skill) => skill.name),
      (await fs.readdir(templates)).sort()
    );
    for (const skill of payload.skills) {
      assert.equal(skill.status, "installed");
      const content = await fs.readFile(skill.skillPath, "utf8");
      assert.equal(
        content,
        await fs.readFile(path.join(templates, skill.name, "SKILL.md"), "utf8")
      );
      assert.ok(content.startsWith(`---\nname: ${skill.name}\ndescription: `));
      assert.ok(content.includes("\n---\n"));
    }
    const destination = payload.skills[0].skillPath;
    await fs.writeFile(destination, "local edits");
    const repeated = run("init-skills", target);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.ok(
      JSON.parse(repeated.stdout).skills.every(
        (skill) => skill.status === "skipped"
      )
    );
    assert.equal(await fs.readFile(destination, "utf8"), "local edits");
    const forced = run("init-skills", target, "--force", "--format", "text");
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /installed:/);
    assert.notEqual(await fs.readFile(destination, "utf8"), "local edits");
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("installer rejects invalid commands and options", () => {
  for (const args of [
    ["unknown"],
    ["init-skills", "--format", "yaml"],
    ["init-skills", "--unknown"]
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
});

test("reports skill discovers, prepares and reads vault notes through an isolated hub", async (context) => {
  const { fork } = require("node:child_process");
  const { once } = require("node:events");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reports-skill-hub-"));
  const child = fork(path.join(__dirname, "artifact-test-server.cjs"), [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      ARTIFACT_TEST_ROOT: root,
      ARTIFACT_TEST_SEED: "browser",
      PLAYWRIGHT_REPORTS_DB_PATH: path.join(root, "app.db")
    }
  });
  context.after(async () => {
    const exit = once(child, "exit");
    child.kill();
    await exit;
    await fs.rm(root, { recursive: true, force: true });
  });
  const [{ url }] = await once(child, "message");
  const response = await fetch(url + "/api/agent/reports/search?scope=current");
  assert.equal(response.status, 200);
  const search = await response.json();
  assert.equal(search.reports.length, 2);
  const report = search.reports.find((entry) => entry.uuid === "fixture-uuid");
  assert.deepEqual(report.analysisFiles, ["fixture-report-analysis-0"]);
  const prepare = await fetch(
    url +
      "/api/agent/reports/prepare?" +
      new URLSearchParams({ reportRef: report.reportRef })
  );
  assert.equal(prepare.status, 200);
  const prepared = await prepare.json();
  assert.equal(prepared.report.uuid, report.uuid);
  assert.equal(
    prepared.analysisTarget.reportRootPath,
    path.join(root, "current/fixture-report")
  );
  assert.ok(
    (await fs.stat(prepared.analysisTarget.reportDataPath)).isDirectory()
  );
  const list = await (await fetch(url + "/api/agent/vault/list")).json();
  assert.ok(
    list.files.some((file) => file.filename === report.analysisFiles[0])
  );
  const note = await fetch(
    url + "/api/agent/vault/" + encodeURIComponent(report.analysisFiles[0])
  );
  assert.equal(note.status, 200);
  assert.equal(await note.text(), "Preserve fixture-report-analysis-0");
  assert.equal((await fetch(url + "/api/agent/vault/missing")).status, 404);
  assert.equal(
    (await fetch(url + "/api/agent/reports/prepare?reportRef=missing")).status,
    404
  );
  assert.equal(
    (await fetch(url + "/api/agent/reports/search?rangeStart=2026-02-30"))
      .status,
    400
  );
  assert.equal(
    (
      await (
        await fetch(url + "/api/agent/reports/search?query=no-matches")
      ).json()
    ).totalCount,
    0
  );
  assert.equal(
    (
      await (
        await fetch(url + "/api/agent/reports/search?query=Synthetic&limit=1")
      ).json()
    ).reports.length,
    1
  );
  assert.equal(
    (
      await (
        await fetch(url + "/api/agent/reports/search?scope=archive")
      ).json()
    ).reports.length,
    0
  );
  const Database = require("better-sqlite3");
  const database = new Database(path.join(root, "app.db"), { readonly: true });
  try {
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM analysis_runs").get()
        .count,
      3
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM digests").get().count,
      0
    );
  } finally {
    database.close();
  }
  await assert.rejects(fs.stat(path.join(root, "commands.log")), {
    code: "ENOENT"
  });
});

test(
  "real report skill handoff and trace command matrix preserve all source files",
  {
    skip: !process.env.PW_REPORTS_SKILL_REPORT,
    timeout: 240000
  },
  async (context) => {
    const { createHash } = require("node:crypto");
    const {
      parseTrendReport,
      resolveTrendAttempt
    } = require("../dist/report-trends");
    const reportRoot = path.resolve(process.env.PW_REPORTS_SKILL_REPORT);
    const readerCli =
      process.env.PW_REPORTS_READER_CLI ||
      require.resolve("@andrii_kremlovskyi/playwright-traces-reader/dist/cli.js");
    const scratch = await fs.mkdtemp(
      path.join(os.tmpdir(), "reports-real-skill-")
    );
    const fingerprint = async () => {
      const hash = createHash("sha256");
      const visit = async (relative) => {
        const target = path.join(reportRoot, relative);
        const stat = await fs.lstat(target);
        hash.update(
          JSON.stringify([
            relative,
            stat.mode,
            stat.size,
            stat.mtimeMs,
            stat.ctimeMs
          ])
        );
        if (stat.isDirectory()) {
          for (const name of (await fs.readdir(target)).sort())
            await visit(path.join(relative, name));
        } else if (stat.isSymbolicLink()) {
          hash.update(await fs.readlink(target));
        } else {
          hash.update(await fs.readFile(target));
        }
      };
      await visit("");
      return hash.digest("hex");
    };
    const before = await fingerprint();
    context.after(async () => {
      try {
        assert.equal(
          await fingerprint(),
          before,
          "The source report must remain unchanged"
        );
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    });
    const executed = new Set();
    const reader = (...args) => {
      const result = spawnSync(process.execPath, [readerCli, ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120000
      });
      assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.command, args[0]);
      executed.add(args[0]);
      return payload;
    };
    reader("init-skills", scratch);
    const report = {
      uuid: "read-only-real-fixture",
      name: "real-fixture",
      metadata: "",
      createdAt: (await fs.stat(reportRoot)).birthtime.toISOString(),
      timestamp: "",
      timeSource: "catalog",
      version: "",
      scope: "current"
    };
    const html = await fs.readFile(path.join(reportRoot, "index.html"), "utf8");
    const observations = parseTrendReport(html, report).flatMap(
      (series) => series.observations
    );
    assert.ok(observations.length > 0);
    for (const status of ["passed", "failed"]) {
      const observation = observations.find((candidate) =>
        candidate.attempts.some((attempt) => attempt.status === status)
      );
      assert.ok(observation, `Fixture must include a ${status} attempt`);
      const attempt = observation.attempts.find(
        (candidate) => candidate.status === status
      );
      const resolved = await resolveTrendAttempt(
        html,
        report,
        reportRoot,
        observation.testId,
        report.version,
        attempt.index
      );
      assert.equal(resolved.traceAvailability, "available");
      const tracePath = resolved.traces[0].tracePath;
      const found = reader("find-traces", reportRoot, observation.title);
      assert.ok(found.traces.some((trace) => trace.tracePath === tracePath));
      const summary = reader("summary", tracePath, "--report", reportRoot);
      assert.equal(summary.summary.status, status);
      const digest = reader(
        "digest",
        tracePath,
        path.join(scratch, status),
        "--report",
        reportRoot
      );
      assert.equal(digest.status, status);
      const digestRoot = path.join(digest.runDir, digest.folder);
      const tree = JSON.parse(
        await fs.readFile(path.join(digestRoot, "digest.json"), "utf8")
      );
      assert.ok(tree.steps.length > 0);
      assert.ok(
        (await fs.stat(path.join(digestRoot, "network.ndjson"))).isFile()
      );
      if (status === "passed") continue;
      reader("slow-steps", tracePath, "--limit", "5");
      reader("steps", tracePath);
      const network = reader(
        "network",
        tracePath,
        "--source",
        "all",
        "--limit",
        "3"
      );
      assert.ok(network.entries.length > 0);
      reader("request", tracePath, String(network.entries[0].id));
      reader("console", tracePath);
      reader("errors", tracePath);
      const attachments = reader("attachments", tracePath);
      assert.ok(attachments.attachments.length > 0);
      reader(
        "attachment",
        tracePath,
        String(attachments.attachments[0].id),
        "--output",
        path.join(scratch, "attachment")
      );
      const domPath = path.join(scratch, "dom.json");
      reader(
        "dom",
        tracePath,
        "--near",
        "last",
        "--limit",
        "3",
        "--output",
        domPath
      );
      const dom = JSON.parse(await fs.readFile(domPath, "utf8"));
      assert.ok(dom.snapshots.length > 0);
      reader("timeline", tracePath);
      const screenshots = reader(
        "screenshots",
        tracePath,
        "--out-dir",
        path.join(scratch, "screenshots")
      );
      assert.ok(screenshots.screenshots.length > 0);
    }
    context.diagnostic(
      `${observations.length} tests; passed/failed handoff; commands: ${[...executed].join(", ")}; source fingerprint checked`
    );
  }
);
