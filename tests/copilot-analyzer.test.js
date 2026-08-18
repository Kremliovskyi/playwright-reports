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
Error: expect(locator).toBeVisible() failed
Locator: getByRole("heading", { name: "Done" })
Expected: visible
Received: hidden
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
  schemaVersion: 2,
  issues,
});

const modelIssue = (overrides = {}) => ({
  blockIndex: 1,
  context: {
    stepPath: ["Example step"],
    previousPassedBoundary: "Example step",
    expected: ["expected value"],
    received: ["actual value"],
    network: [],
    transientVsFinalContradiction: null,
  },
  interpretation: {
    expectedStateLabel: null,
    observedStateLabel: "Done",
    causalRole: "unclassified",
    causedByBlockIndex: null,
    transitionBoundary: "Example step",
    explanation: "The authoritative assertion failed.",
    rootCauseHypothesis: null,
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

  const responses = Array.isArray(response) ? response : [response];
  const sentPrompts = [];
  let sessionCount = 0;
  const client = {
    async createSession() {
      sessionCount++;
      return {
        async sendAndWait(options) {
          sentPrompts.push(options.prompt);
          const responseIndex = Math.min(
            sentPrompts.length - 1,
            responses.length - 1,
          );
          return {
            data: { content: JSON.stringify(responses[responseIndex]) },
          };
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
    return {
      result,
      sentPrompt: sentPrompts[0],
      sentPrompts,
      sessionCount,
      evidenceJson,
      analysisMarkdown,
    };
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
  assert.match(sentPrompt, /deterministic source projection/);
  assert.match(sentPrompt, /Do not return terminal, source references/);
  assert.equal(result.records[0].issues[0].facts.operation, "toBeVisible");
  assert.equal(
    result.records[0].issues[0].facts.target,
    'getByRole("heading", { name: "Done" })',
  );
  assert.deepEqual(result.records[0].issues[0].facts.sourceRefs, ["B1-L1"]);
  assert.equal(JSON.parse(evidenceJson).schemaVersion, 2);
  assert.match(analysisMarkdown, /Issue 1 \(terminal\)/);
  assert.match(analysisMarkdown, /Operation key.*tobevisible/);
});

test("repairs a semantic response whose issue count differs from error.md", async () => {
  const { result, sentPrompts } = await runAnalysis([
    modelRecord([modelIssue(), modelIssue({ blockIndex: 2 })]),
    modelRecord([modelIssue()]),
  ]);

  assert.equal(result.analyzed, 1);
  assert.equal(result.failed, 0);
  assert.equal(sentPrompts.length, 2);
  assert.match(sentPrompts[1], /2 issues for 1 error\.md blocks/);
});

test("ignores model-authored source facts and normalization", async () => {
  const issue = modelIssue();
  issue.facts = {
    operation: "invented operation",
    errorVerbatim: "invented error",
    blockQuotes: ["invented quote"],
  };
  issue.normalization = {
    failureFamily: "invented-family",
    operationKey: "invented-operation",
  };
  const { result } = await runAnalysis(modelRecord([issue]));

  const evidence = result.records[0].issues[0];
  assert.equal(result.analyzed, 1);
  assert.equal(evidence.facts.operation, "toBeVisible");
  assert.equal(
    evidence.facts.errorVerbatim,
    "Error: expect(locator).toBeVisible() failed",
  );
  assert.equal(evidence.normalization.failureFamily, "assertion-mismatch");
  assert.equal(evidence.normalization.operationKey, "tobevisible");
  assert.doesNotMatch(JSON.stringify(evidence), /invented/);
});

test("repairs a non-scalar semantic state label in the same session", async () => {
  const invalidIssue = modelIssue();
  invalidIssue.interpretation.observedStateLabel = {
    heading: "Done",
    message: "The attempt completed.",
  };
  const { result, sentPrompts } = await runAnalysis([
    modelRecord([invalidIssue]),
    modelRecord([modelIssue()]),
  ]);

  assert.equal(result.analyzed, 1);
  assert.equal(result.failed, 0);
  assert.equal(sentPrompts.length, 2);
  assert.match(
    sentPrompts[1],
    /interpretation\.observedStateLabel must be a string or null; received object/,
  );
  assert.match(sentPrompts[1], /deterministic-source-projection-json/);
});

test("records primary and downstream causal roles from generated evidence", async () => {
  const multiBlockErrorMarkdown = `# Error details

\`\`\`
Error: expect(locator).toMatchAriaSnapshot(expected) failed

- Expected  - 1
+ Received  + 1

- - heading "Account Overview"
+ - heading "Consent Review"
\`\`\`

\`\`\`
TimeoutError: locator.click: Timeout 10000ms exceeded
Locator: getByRole("button", { name: "Download Statement" })
\`\`\`

# Page snapshot

\`\`\`yaml
- heading "Consent Review"
\`\`\`
`;
  const firstIssue = modelIssue({ blockIndex: 1 });
  firstIssue.context.expected = [];
  firstIssue.context.received = [];
  firstIssue.interpretation = {
    ...firstIssue.interpretation,
    expectedStateLabel: "Account Overview",
    observedStateLabel: "Consent Review",
    causalRole: "primary-state-mismatch",
    transitionBoundary: "Example step",
  };
  const secondIssue = modelIssue({ blockIndex: 2 });
  secondIssue.interpretation = {
    ...secondIssue.interpretation,
    expectedStateLabel: null,
    observedStateLabel: "Consent Review",
    causalRole: "downstream-symptom",
    causedByBlockIndex: 1,
    transitionBoundary: "Example step",
  };

  const { result } = await runAnalysis(
    modelRecord([firstIssue, secondIssue]),
    multiBlockErrorMarkdown,
  );

  assert.equal(result.analyzed, 1);
  assert.equal(result.records[0].issues.length, 2);
  assert.equal(
    result.records[0].issues[0].normalization.observedStateKey,
    "consent-review",
  );
  assert.equal(
    result.records[0].issues[1].interpretation.causalRole,
    "downstream-symptom",
  );
  assert.equal(
    result.records[0].issues[1].interpretation.causedByBlockIndex,
    1,
  );
  assert.equal(
    result.records[0].issues[1].normalization.transitionBoundaryKey,
    "example-step",
  );
});

test("parses only changed ARIA lines and generates source references", async () => {
  const ariaDiffErrorMarkdown = `# Error details

\`\`\`
Error: expect(locator).toMatchAriaSnapshot(expected) failed

- Expected  - 3
+ Received  + 1

  - heading "Document review"
- - paragraph "Note: Bring the original document"
+ - paragraph "Hint: Digital copies are accepted"
\`\`\`

# Page snapshot

\`\`\`yaml
- heading "Submission complete"
\`\`\`
`;
  const issue = modelIssue();
  issue.context.expected = ["model must not classify unchanged context"];
  issue.context.received = [];
  issue.interpretation = {
    ...issue.interpretation,
    observedStateLabel: "Submission complete",
    causalRole: "content-mismatch",
  };
  const { result } = await runAnalysis(
    modelRecord([issue]),
    ariaDiffErrorMarkdown,
  );

  const evidence = result.records[0].issues[0];
  assert.equal(result.analyzed, 1);
  assert.equal(evidence.facts.ariaDiff.removed.length, 1);
  assert.equal(evidence.facts.ariaDiff.added.length, 1);
  assert.match(evidence.facts.ariaDiff.removed[0].text, /Note:/);
  assert.doesNotMatch(
    JSON.stringify(evidence.facts.ariaDiff),
    /Document review/,
  );
  assert.deepEqual(evidence.facts.sourceRefs, ["B1-L1", "B1-L7", "B1-L8"]);
  assert.deepEqual(evidence.facts.expected, [
    'paragraph "Note: Bring the original document"',
  ]);
  assert.match(evidence.normalization.differenceKeys[0], /^missing:/);
});

test("keeps canonical keys invariant across semantic wording", async () => {
  const first = modelIssue();
  first.interpretation.explanation = "The heading is not visible.";
  const second = modelIssue();
  second.interpretation.explanation = "The expected heading could not be seen.";

  const firstRun = await runAnalysis(modelRecord([first]));
  const secondRun = await runAnalysis(modelRecord([second]));
  assert.deepEqual(
    firstRun.result.records[0].issues[0].normalization,
    secondRun.result.records[0].issues[0].normalization,
  );
});

test("retains deterministic evidence after two invalid model responses", async () => {
  const invalid = modelRecord([]);
  const { result, sentPrompts, analysisMarkdown } = await runAnalysis([
    invalid,
    invalid,
  ]);

  assert.equal(sentPrompts.length, 2);
  assert.equal(result.analyzed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.records[0].issues.length, 1);
  assert.match(
    result.records[0].warning,
    /deterministic source evidence retained/,
  );
  assert.equal(result.records[0].issues[0].facts.operation, "toBeVisible");
  assert.match(analysisMarkdown, /Small-model interpretation unavailable/);
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
