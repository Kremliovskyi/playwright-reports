const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { analyzeRun } = require("../dist/copilot-analyzer");

const errorMarkdown = `# Test info

- Name: tests/example.spec.ts >> example

# Error details

\`\`\`
Error: authoritative failure
\`\`\`

# Page snapshot

\`\`\`yaml
- heading "Done"
\`\`\`

# Test source

\`\`\`ts
expect.soft(value).toBe(expected);
\`\`\`
`;

const modelRecord = (issues) => ({
  schemaVersion: 1,
  issues,
});

const modelIssue = (overrides = {}) => ({
  blockIndex: 1,
  terminal: true,
  facts: {
    kind: "soft assertion",
    assertion: "toBe",
    operation: "Assert example value",
    target: "example value",
    stepPath: ["Example step"],
    previousPassedBoundary: "Example setup completed",
    errorVerbatim: "Error: authoritative failure",
    expected: ["expected value"],
    received: ["actual value"],
    network: [],
    finalPageState: "Done",
    transientVsFinalContradiction: null,
    blockQuotes: ["Error: authoritative failure"],
  },
  normalization: {
    failureFamily: "value-mismatch",
    operationKey: "assert-value",
    targetKey: "example-value",
    normalizedError: "authoritative failure",
    differenceKeys: ["expected-value:actual-value"],
    volatileValuesRemoved: [],
  },
  interpretation: {
    explanation: "The authoritative assertion failed.",
    rootCauseHypothesis: "The value did not match.",
    confidence: "high",
    ambiguities: [],
  },
  ...overrides,
});

const runAnalysis = async (response, errorMd = errorMarkdown) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-analyzer-"));
  const folder = "attempt__retry0";
  fs.mkdirSync(path.join(runDir, folder));
  fs.writeFileSync(path.join(runDir, folder, "error.md"), errorMd);
  fs.writeFileSync(
    path.join(runDir, folder, "failure.json"),
    JSON.stringify({
      testTitle: "tests/example.spec.ts:1 › example",
      title: "Example step",
      status: "failed",
      outcome: "unexpected",
      retryIndex: 0,
      issues: [{ message: "Error: must not reach the model" }],
      actionDiagnostics: [{ message: "Error: must not reach the model" }],
      topLevelSteps: [
        {
          callId: "test.step@1",
          parentId: null,
          title: "Example step",
          method: "test.step",
          error: { message: "Error: must not reach the model" },
          children: [],
        },
      ],
      files: { errorMarkdown: "error.md" },
    }),
  );

  let sentPrompt;
  let sessionCount = 0;
  const client = {
    async createSession() {
      sessionCount++;
      return {
        async sendAndWait(options) {
          sentPrompt = options.prompt;
          return { data: { content: JSON.stringify(response) } };
        },
        async disconnect() {},
      };
    },
  };
  try {
    const result = await analyzeRun(
      client,
      runDir,
      {
        count: 1,
        runDir,
        failures: [
          {
            folder,
            testTitle: "tests/example.spec.ts:1 › example",
            title: "Example step",
            retryIndex: 0,
            status: "failed",
            outcome: "unexpected",
          },
        ],
      },
      "small-model",
    );
    const evidenceJson = fs.readFileSync(
      path.join(runDir, folder, "evidence.json"),
      "utf8",
    );
    const analysisMarkdown = fs.readFileSync(
      path.join(runDir, folder, "ai-analysis.md"),
      "utf8",
    );
    return { result, sentPrompt, sessionCount, evidenceJson, analysisMarkdown };
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
};

test("uses error.md as the exclusive issue source", async () => {
  const { result, sentPrompt, evidenceJson, analysisMarkdown } =
    await runAnalysis(modelRecord([modelIssue()]));

  assert.equal(result.analyzed, 1);
  assert.equal(result.failed, 0);
  assert.match(sentPrompt, /contains exactly 1 fenced error block/);
  assert.doesNotMatch(sentPrompt, /must not reach the model/);
  assert.match(sentPrompt, /"title": "Example step"/);
  assert.match(sentPrompt, /"blockQuotes"/);
  assert.equal(
    result.records[0].issues[0].facts.operation,
    "Assert example value",
  );
  assert.equal(JSON.parse(evidenceJson).schemaVersion, 1);
  assert.match(analysisMarkdown, /Issue 1 \(terminal\)/);
  assert.match(analysisMarkdown, /Operation key.*assert-value/);
});

test("rejects a record whose issue count differs from error.md", async () => {
  const { result } = await runAnalysis(
    modelRecord([modelIssue(), modelIssue({ blockIndex: 2 })]),
  );

  assert.equal(result.analyzed, 0);
  assert.equal(result.failed, 1);
  assert.match(result.records[0].error, /2 issues for 1 error\.md blocks/);
});

test("rejects evidence quotes that are not present in the source block", async () => {
  const issue = modelIssue();
  issue.facts.blockQuotes = ["fabricated quote"];
  const { result, analysisMarkdown } = await runAnalysis(modelRecord([issue]));

  assert.equal(result.analyzed, 0);
  assert.equal(result.failed, 1);
  assert.match(result.records[0].error, /quote not found/);
  assert.match(analysisMarkdown, /AI evidence extraction failed/);
});

test("rejects error.md without authoritative blocks before model invocation", async () => {
  const { result, sessionCount, analysisMarkdown } = await runAnalysis(
    modelRecord([]),
    "# Error details\n\n# Page snapshot\n",
  );

  assert.equal(sessionCount, 0);
  assert.equal(result.analyzed, 0);
  assert.equal(result.failed, 1);
  assert.match(result.records[0].error, /no fenced error blocks/);
  assert.match(analysisMarkdown, /AI evidence extraction failed/);
});

test("does not write error artifacts outside the run directory", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-analyzer-run-"),
  );
  const escapedFolder = `copilot-analyzer-escaped-${path.basename(runDir)}`;
  const escapedPath = path.join(path.dirname(runDir), escapedFolder);
  fs.mkdirSync(escapedPath);
  let sessionCount = 0;
  const client = {
    async createSession() {
      sessionCount++;
      throw new Error("Model session must not be created");
    },
  };

  try {
    const result = await analyzeRun(
      client,
      runDir,
      {
        count: 1,
        runDir,
        failures: [
          {
            folder: `../${escapedFolder}`,
            testTitle: "tests/example.spec.ts:1 › example",
            title: "Example step",
            retryIndex: 0,
            status: "failed",
            outcome: "unexpected",
          },
        ],
      },
      "small-model",
    );
    assert.equal(sessionCount, 0);
    assert.equal(result.failed, 1);
    assert.match(result.records[0].error, /outside its allowed directory/);
    assert.equal(fs.existsSync(path.join(escapedPath, "evidence.json")), false);
    assert.equal(
      fs.existsSync(path.join(escapedPath, "ai-analysis.md")),
      false,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(escapedPath, { recursive: true, force: true });
  }
});
