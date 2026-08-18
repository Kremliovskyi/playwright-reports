const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  groupRun,
  GroupingRunError,
  parseGroupingResponse,
  renderGroupedAnalysis,
  validateGroupingResponse,
} = require("../dist/copilot-grouper");

const entry = (folder, retryIndex, outcome, testName = "e2eFlowTC01") => ({
  folder,
  testTitle: `tests/e2e/example.spec.ts:42 › flow › ${testName}`,
  title: "Complete the flow",
  retryIndex,
  status: "failed",
  outcome,
});

const record = (folder, issues, overrides = {}) => ({
  schemaVersion: 1,
  model: "small-model",
  attempt: {
    folder,
    testTitle: `tests/e2e/example.spec.ts:42 › flow › e2eFlowTC01`,
    spec: "tests/e2e/example.spec.ts:42",
    retryIndex: 0,
    status: "failed",
    outcome: "unexpected",
  },
  issues: issues.map((issue, index) => ({
    ...issue,
    blockIndex: index + 1,
    terminal: index === issues.length - 1,
    facts: {
      ...issue.facts,
      finalPageState:
        index === issues.length - 1 ? issue.facts.finalPageState : null,
      transientVsFinalContradiction:
        index === issues.length - 1
          ? issue.facts.transientVsFinalContradiction
          : null,
    },
  })),
  ...overrides,
});

const softIssue = {
  facts: {
    kind: "soft assertion",
    assertion: "toMatchAriaSnapshot",
    operation: "Assert loading screen",
    target: "loading screen body",
    stepPath: ["Open flow", "Check loading screen"],
    previousPassedBoundary: "Open flow completed",
    errorVerbatim: "Unexpected Back button",
    expected: ["Back button absent"],
    received: ["Back button present"],
    network: [],
    finalPageState: null,
    transientVsFinalContradiction: null,
    blockQuotes: ["Unexpected Back button"],
  },
  normalization: {
    failureFamily: "aria-snapshot-mismatch",
    operationKey: "assert-aria-snapshot",
    targetKey: "loading-screen-body",
    normalizedError: "unexpected back button",
    differenceKeys: ["unexpected:button:back"],
    volatileValuesRemoved: [],
  },
  interpretation: {
    explanation: "The loading screen contains an extra Back button.",
    rootCauseHypothesis: "The loading snapshot changed.",
    confidence: "high",
    ambiguities: [],
  },
};

const terminalIssue = {
  facts: {
    kind: "timeout",
    assertion: "toBeVisible",
    operation: "Click result button",
    target: "result button",
    stepPath: ["Open flow", "Complete the flow"],
    previousPassedBoundary: "Open flow completed",
    errorVerbatim: "Timeout 10000ms exceeded",
    expected: ["Result visible within 10 seconds"],
    received: ["Result visible after 10 seconds"],
    network: [],
    finalPageState: "The result screen is visible.",
    transientVsFinalContradiction: "The result eventually appeared.",
    blockQuotes: ["Timeout 10000ms exceeded"],
  },
  normalization: {
    failureFamily: "visibility-timeout",
    operationKey: "click-result-button",
    targetKey: "result-button",
    normalizedError: "timeout waiting for result",
    differenceKeys: ["result-visible-after-timeout"],
    volatileValuesRemoved: [],
  },
  interpretation: {
    explanation: "The result appeared after the assertion window.",
    rootCauseHypothesis: "The result exceeded the assertion window.",
    confidence: "high",
    ambiguities: [],
  },
};

const modelProblem = (issueIds, overrides = {}) => ({
  title: "Grouped issue",
  error: "Representative error",
  whatHappens: "The observed operation fails.",
  rootCause: "The operation did not reach the expected state.",
  issueIds,
  ...overrides,
});

test("renders retries and secondary issues without inflating reconciliation", () => {
  const manifest = {
    count: 3,
    runDir: "/tmp/run-test",
    failures: [
      entry("attempt-a__retry0", 0, "unexpected"),
      entry("attempt-a__retry1", 1, "flaky"),
      { ...entry("skipped__retry0", 0, "skipped"), outcome: "skipped" },
    ],
  };
  const records = [
    record("attempt-a__retry0", [softIssue, terminalIssue]),
    record("attempt-a__retry1", [terminalIssue]),
  ];
  const response = validateGroupingResponse(
    {
      summary: "One loading-state issue and one shared terminal timeout.",
      problems: [
        {
          title: "Unexpected loading controls",
          error: "Unexpected Back button",
          whatHappens: "The loading screen shows an extra control.",
          rootCause: "The loading snapshot changed | unexpectedly.",
          issueRefs: [{ folder: "attempt-a__retry0", issueIndex: 1 }],
        },
        {
          title: "Result exceeds assertion window",
          error: "Timeout 10000ms exceeded",
          whatHappens: "The result eventually appears.",
          rootCause: "The result is slow.",
          issueRefs: [
            { folder: "attempt-a__retry0", issueIndex: 2 },
            { folder: "attempt-a__retry1", issueIndex: 1 },
          ],
        },
      ],
    },
    records,
  );

  const markdown = renderGroupedAnalysis(
    "/tmp/run-test",
    manifest,
    records,
    response,
    "small-model",
    "big-model",
  );
  assert.match(markdown, /\| 1 \| Unexpected loading controls \| 1 \| 0\*/);
  assert.match(
    markdown,
    /\| 2 \| Result exceeds assertion window \| 1 \| 2 \| 1 unexpected, 1 flaky/,
  );
  assert.match(markdown, /retry0/);
  assert.match(markdown, /retry1/);
  assert.match(markdown, /changed \\| unexpectedly/);
  assert.match(markdown, /Problem 1 shares 1 attempt counted under Problem 2/);
  assert.match(markdown, /\*\*Total: 2 = 2 failed attempts\*\*/);
  assert.doesNotMatch(markdown, /skipped__retry0/);
});

test("rejects duplicate and unknown issue references", () => {
  const records = [record("attempt__retry0", [softIssue, terminalIssue])];
  assert.throws(
    () =>
      validateGroupingResponse(
        {
          summary: "Duplicate",
          problems: [
            {
              title: "Duplicate",
              error: "error",
              whatHappens: "behavior",
              rootCause: "cause",
              issueRefs: [
                { folder: "attempt__retry0", issueIndex: 1 },
                { folder: "attempt__retry0", issueIndex: 1 },
              ],
            },
          ],
        },
        records,
      ),
    /more than once/,
  );

  assert.throws(
    () =>
      validateGroupingResponse(
        {
          summary: "Unknown",
          problems: [
            {
              title: "Unknown",
              error: "error",
              whatHappens: "behavior",
              rootCause: "cause",
              issueRefs: [{ folder: "attempt__retry0", issueIndex: 3 }],
            },
          ],
        },
        records,
      ),
    /unknown issue/,
  );
});

test("preserves partial grouping and classifies omitted issues", () => {
  const manifest = {
    count: 1,
    runDir: "/tmp/run-test",
    failures: [entry("attempt__retry0", 0, "unexpected")],
  };
  const records = [record("attempt__retry0", [softIssue, terminalIssue])];
  const response = validateGroupingResponse(
    {
      summary: "The model grouped one of two issues.",
      problems: [
        {
          title: "Unexpected loading controls",
          error: "Unexpected Back button",
          whatHappens: "The loading screen shows an extra control.",
          rootCause: "The loading snapshot changed.",
          issueRefs: [{ folder: "attempt__retry0", issueIndex: 1 }],
        },
      ],
    },
    records,
  );

  assert.equal(response.problems.length, 2);
  assert.equal(response.problems[0].title, "Unexpected loading controls");
  assert.deepEqual(response.problems[1].issueRefs, [
    { folder: "attempt__retry0", issueIndex: 2 },
  ]);

  const markdown = renderGroupedAnalysis(
    "/tmp/run-test",
    manifest,
    records,
    response,
    "small-model",
    "big-model",
  );
  assert.match(markdown, /Unclassified - omitted by grouping model/);
  assert.match(
    markdown,
    /The grouping response omitted required issue references/,
  );
  assert.match(markdown, /\*\*Total: 1 = 1 failed attempts\*\*/);
});

test("places failed per-trace records in an unclassified terminal problem", () => {
  const manifest = {
    count: 1,
    runDir: "/tmp/run-test",
    failures: [entry("failed-ai__retry0", 0, "unexpected")],
  };
  const records = [
    record("failed-ai__retry0", [], { error: "Model response was invalid" }),
  ];
  const response = validateGroupingResponse(
    parseGroupingResponse(
      JSON.stringify({
        summary: "One attempt could not be classified.",
        problems: [],
      }),
    ),
    records,
  );
  const markdown = renderGroupedAnalysis(
    "/tmp/run-test",
    manifest,
    records,
    response,
    "small-model",
    "big-model",
  );
  assert.match(markdown, /Unclassified - per-trace analysis unavailable/);
  assert.match(markdown, /\*\*Total: 1 = 1 failed attempts\*\*/);
});

test("embeds grouping records in one tool-free big-model call and writes only a validated report", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-group-run-"));
  try {
    const manifest = {
      count: 1,
      runDir,
      failures: [entry("attempt__retry0", 0, "unexpected")],
    };
    const records = [record("attempt__retry0", [terminalIssue])];
    fs.writeFileSync(path.join(runDir, "index.json"), JSON.stringify(manifest));
    fs.mkdirSync(path.join(runDir, "attempt__retry0"));
    fs.writeFileSync(
      path.join(runDir, "attempt__retry0", "ai-analysis.md"),
      "# AI Analysis\n\n## Issues\n\n1. timeout",
    );

    let sessionConfig;
    let callCount = 0;
    let sentOptions;
    let disconnected = false;
    let eventHandler;
    const client = {
      async createSession(config) {
        sessionConfig = config;
        return {
          on(handler) {
            eventHandler = handler;
            return () => {
              eventHandler = undefined;
            };
          },
          async sendAndWait(options) {
            callCount += 1;
            sentOptions = options;
            eventHandler({
              type: "session.usage_info",
              data: { currentTokens: 2500, tokenLimit: 272000 },
            });
            eventHandler({
              type: "assistant.usage",
              data: {
                model: "big-model",
                inputTokens: 2200,
                outputTokens: 300,
                finishReason: "stop",
              },
            });
            return {
              data: {
                content: JSON.stringify({
                  summary: "One terminal timeout.",
                  problems: [
                    {
                      title: "Terminal timeout",
                      error: "Timeout 10000ms exceeded",
                      whatHappens: "The result appears too late.",
                      rootCause: "The result exceeded the assertion window.",
                      issueIds: ["I1"],
                    },
                  ],
                }),
              },
            };
          },
          async disconnect() {
            disconnected = true;
          },
        };
      },
    };

    const result = await groupRun(
      client,
      runDir,
      manifest,
      records,
      "small-model",
      "big-model",
    );
    assert.deepEqual(sessionConfig, {
      model: "big-model",
      reasoningEffort: "high",
      contextTier: "default",
      availableTools: [],
    });
    assert.equal(callCount, 1);
    assert.equal(sentOptions.attachments, undefined);
    assert.match(sentOptions.prompt, /<grouping-input-json>/);
    assert.match(sentOptions.prompt, /"folder":"attempt__retry0"/);
    assert.match(sentOptions.prompt, /"issueId":"I1"/);
    assert.match(sentOptions.prompt, /"issueIds": \["I1", "I2"\]/);
    assert.match(sentOptions.prompt, /"operation":"Click result button"/);
    assert.match(
      sentOptions.prompt,
      /"previousPassedBoundary":"Open flow completed"/,
    );
    assert.match(sentOptions.prompt, /"failureFamily":"visibility-timeout"/);
    assert.match(
      sentOptions.prompt,
      /Test titles and manifest steps are scenario context, not standalone signatures/,
    );
    assert.match(
      sentOptions.prompt,
      /Do not use a missing optional field alone as positive evidence to split/,
    );
    assert.match(
      sentOptions.prompt,
      /A material factual conflict is evidence to split; uncertainty is a reason to request evidence/,
    );
    assert.equal(disconnected, true);
    assert.equal(result.problemCount, 1);
    assert.equal(result.diagnostics.stage, "complete");
    assert.equal(result.diagnostics.reasoningEffort, "high");
    assert.equal(result.diagnostics.requestCount, 1);
    assert.equal(result.diagnostics.repairAttempted, false);
    assert.equal(result.diagnostics.evidenceRoundAttempted, false);
    assert.equal(result.diagnostics.evidenceRequestCount, 0);
    assert.equal(result.diagnostics.contextTokenLimit, 272000);
    assert.equal(result.diagnostics.inputTokens, 2200);
    assert.equal(result.diagnostics.outputTokens, 300);
    assert.equal(result.diagnostics.finishReason, "stop");
    assert.equal(fs.existsSync(path.join(runDir, "grouped-analysis.md")), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("loads bounded raw evidence for one grouping follow-up turn", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-group-evidence-"),
  );
  const folder = "attempt__retry0";
  const manifest = {
    count: 1,
    runDir,
    failures: [entry(folder, 0, "unexpected")],
  };
  const records = [record(folder, [softIssue, terminalIssue])];
  fs.mkdirSync(path.join(runDir, folder));
  fs.writeFileSync(
    path.join(runDir, folder, "error.md"),
    `# Error details

\`\`\`
Unexpected Back button
\`\`\`

\`\`\`
Timeout 10000ms exceeded
\`\`\`

# Page snapshot

\`\`\`yaml
- heading "Result"
\`\`\`

# Test source

\`\`\`ts
await expect(result).toBeVisible();
\`\`\`
`,
  );

  const responses = [
    {
      summary: "The issues may share one delayed-flow problem.",
      problems: [modelProblem(["I1", "I2"])],
      evidenceRequests: [
        {
          issueIds: ["I1", "I2"],
          sections: ["error-block", "final-page"],
          reason:
            "Confirm whether the earlier UI mismatch is the timeout state.",
        },
      ],
    },
    {
      summary: "The source blocks show two distinct signatures.",
      problems: [
        modelProblem(["I1"], { title: "Unexpected loading control" }),
        modelProblem(["I2"], { title: "Delayed result" }),
      ],
      evidenceRequests: [],
    },
  ];
  const prompts = [];
  const client = {
    async createSession() {
      return {
        on() {
          return () => {};
        },
        async sendAndWait(options) {
          prompts.push(options.prompt);
          return {
            data: { content: JSON.stringify(responses[prompts.length - 1]) },
          };
        },
        async disconnect() {},
      };
    },
  };

  try {
    const result = await groupRun(
      client,
      runDir,
      manifest,
      records,
      "small-model",
      "big-model",
    );
    const markdown = fs.readFileSync(result.filePath, "utf8");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Unexpected Back button/);
    assert.match(prompts[1], /Timeout 10000ms exceeded/);
    assert.match(prompts[1], /heading \\"Result\\"/);
    assert.match(prompts[1], /not applicable to a non-terminal issue/);
    assert.equal(result.problemCount, 2);
    assert.equal(result.diagnostics.requestCount, 2);
    assert.equal(result.diagnostics.evidenceRoundAttempted, true);
    assert.equal(result.diagnostics.evidenceRequestCount, 1);
    assert.equal(result.diagnostics.evidenceIssueCount, 2);
    assert.ok(result.diagnostics.evidenceBytes > 0);
    assert.match(markdown, /Unexpected loading control/);
    assert.match(markdown, /Delayed result/);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("retains provisional grouping when an evidence request is invalid", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-group-invalid-evidence-"),
  );
  const folder = "attempt__retry0";
  const manifest = {
    count: 1,
    runDir,
    failures: [entry(folder, 0, "unexpected")],
  };
  const records = [record(folder, [terminalIssue])];
  const prompts = [];
  const client = {
    async createSession() {
      return {
        on() {
          return () => {};
        },
        async sendAndWait(options) {
          prompts.push(options.prompt);
          return {
            data: {
              content: JSON.stringify({
                summary: "The provisional grouping remains complete.",
                problems: [
                  modelProblem(["I1"], { title: "Provisional timeout" }),
                ],
                evidenceRequests: [
                  {
                    issueIds: ["I99"],
                    sections: ["error-block"],
                    reason: "Inspect an issue outside the current run.",
                  },
                ],
              }),
            },
          };
        },
        async disconnect() {},
      };
    },
  };

  try {
    const result = await groupRun(
      client,
      runDir,
      manifest,
      records,
      "small-model",
      "big-model",
    );
    const markdown = fs.readFileSync(result.filePath, "utf8");
    assert.equal(prompts.length, 1);
    assert.equal(result.problemCount, 1);
    assert.equal(result.diagnostics.evidenceRoundAttempted, true);
    assert.equal(result.diagnostics.evidenceRequestCount, 1);
    assert.equal(result.diagnostics.requestCount, 1);
    assert.match(result.diagnostics.evidenceErrorMessage, /unknown issue I99/);
    assert.match(markdown, /Provisional timeout/);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("does not read requested evidence outside its failure folder", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-group-contained-evidence-"),
  );
  const folder = "attempt__retry0";
  const folderPath = path.join(runDir, folder);
  const secret = "must not reach the grouping model";
  fs.mkdirSync(folderPath);
  fs.writeFileSync(
    path.join(folderPath, "error.md"),
    "# Error details\n\n```\nTimeout 10000ms exceeded\n```\n",
  );
  fs.writeFileSync(
    path.join(folderPath, "failure.json"),
    JSON.stringify({ files: { networkErrors: "../secret.ndjson" } }),
  );
  fs.writeFileSync(path.join(runDir, "secret.ndjson"), secret);
  const prompts = [];
  const client = {
    async createSession() {
      return {
        on() {
          return () => {};
        },
        async sendAndWait(options) {
          prompts.push(options.prompt);
          return {
            data: {
              content: JSON.stringify({
                summary: "Keep the complete provisional grouping.",
                problems: [modelProblem(["I1"])],
                evidenceRequests: [
                  {
                    issueIds: ["I1"],
                    sections: ["network"],
                    reason: "Inspect the relevant failed request.",
                  },
                ],
              }),
            },
          };
        },
        async disconnect() {},
      };
    },
  };

  try {
    const result = await groupRun(
      client,
      runDir,
      { count: 1, runDir, failures: [entry(folder, 0, "unexpected")] },
      [record(folder, [terminalIssue])],
      "small-model",
      "big-model",
    );
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0], new RegExp(secret));
    assert.match(
      result.diagnostics.evidenceErrorMessage,
      /outside its allowed directory/,
    );
    assert.equal(result.problemCount, 1);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("retains provisional grouping when a requested error block is unavailable", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-group-missing-block-"),
  );
  const folder = "attempt__retry0";
  fs.mkdirSync(path.join(runDir, folder));
  fs.writeFileSync(path.join(runDir, folder, "error.md"), "# Error details\n");
  const client = {
    async createSession() {
      return {
        on() {
          return () => {};
        },
        async sendAndWait() {
          return {
            data: {
              content: JSON.stringify({
                summary: "Keep the complete provisional grouping.",
                problems: [modelProblem(["I1"])],
                evidenceRequests: [
                  {
                    issueIds: ["I1"],
                    sections: ["error-block"],
                    reason: "Inspect the exact source error.",
                  },
                ],
              }),
            },
          };
        },
        async disconnect() {},
      };
    },
  };

  try {
    const result = await groupRun(
      client,
      runDir,
      { count: 1, runDir, failures: [entry(folder, 0, "unexpected")] },
      [record(folder, [terminalIssue])],
      "small-model",
      "big-model",
    );
    assert.match(result.diagnostics.evidenceErrorMessage, /is unavailable/);
    assert.equal(result.problemCount, 1);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("repairs an incomplete provisional grouping without consuming evidence", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-group-provisional-repair-"),
  );
  const folder = "attempt__retry0";
  const prompts = [];
  const responses = [
    {
      summary: "The provisional response omitted one issue.",
      problems: [modelProblem(["I1"])],
      evidenceRequests: [
        {
          issueIds: ["I1", "I2"],
          sections: ["error-block"],
          reason: "Compare the two issues.",
        },
      ],
    },
    {
      summary: "Both issues are now assigned.",
      problems: [modelProblem(["I1", "I2"])],
      evidenceRequests: [],
    },
  ];
  const client = {
    async createSession() {
      return {
        on() {
          return () => {};
        },
        async sendAndWait(options) {
          prompts.push(options.prompt);
          return {
            data: { content: JSON.stringify(responses[prompts.length - 1]) },
          };
        },
        async disconnect() {},
      };
    },
  };

  try {
    const result = await groupRun(
      client,
      runDir,
      { count: 1, runDir, failures: [entry(folder, 0, "unexpected")] },
      [record(folder, [softIssue, terminalIssue])],
      "small-model",
      "big-model",
    );
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /violated the exact issueId reference contract/);
    assert.doesNotMatch(prompts[1], /requested bounded source evidence/);
    assert.match(
      result.diagnostics.evidenceErrorMessage,
      /provisional grouping does not reference every issue exactly once/,
    );
    assert.equal(result.diagnostics.repairAttempted, true);
    assert.equal(result.diagnostics.requestCount, 2);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("repairs omitted issues in the same grouping session", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-group-repair-"),
  );
  const manifest = {
    count: 1,
    runDir,
    failures: [entry("attempt__retry0", 0, "unexpected")],
  };
  const records = [record("attempt__retry0", [softIssue, terminalIssue])];
  const prompts = [];
  const responses = [
    {
      summary: "One issue was grouped and one was omitted.",
      problems: [
        {
          title: "Unexpected loading controls",
          error: "Unexpected Back button",
          whatHappens: "The loading screen shows an extra control.",
          rootCause: "The loading snapshot changed.",
          issueIds: ["I1"],
        },
      ],
    },
    {
      summary: "A loading issue and a terminal timeout occurred.",
      problems: [
        {
          title: "Unexpected loading controls",
          error: "Unexpected Back button",
          whatHappens: "The loading screen shows an extra control.",
          rootCause: "The loading snapshot changed.",
          issueIds: ["I1"],
        },
        {
          title: "Result exceeds assertion window",
          error: "Timeout 10000ms exceeded",
          whatHappens: "The result appears after the timeout.",
          rootCause: "The result is slow.",
          issueIds: ["I2"],
        },
      ],
    },
  ];
  const client = {
    async createSession() {
      return {
        on() {
          return () => {};
        },
        async sendAndWait(options) {
          prompts.push(options.prompt);
          return {
            data: { content: JSON.stringify(responses[prompts.length - 1]) },
          };
        },
        async disconnect() {},
      };
    },
  };

  try {
    const result = await groupRun(
      client,
      runDir,
      manifest,
      records,
      "small-model",
      "big-model",
    );
    const markdown = fs.readFileSync(result.filePath, "utf8");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /FULL corrected grouping JSON object/);
    assert.match(prompts[1], /"issueId":"I2"/);
    assert.match(prompts[1], /<allowed-issue-ids-json>/);
    assert.match(prompts[1], /Unexpected loading controls/);
    assert.equal(result.problemCount, 2);
    assert.equal(result.diagnostics.requestCount, 2);
    assert.equal(result.diagnostics.repairAttempted, true);
    assert.equal(result.diagnostics.omittedIssueCountBeforeRepair, 1);
    assert.equal(result.diagnostics.omittedIssueCountAfterRepair, 0);
    assert.doesNotMatch(markdown, /Unclassified - omitted by grouping model/);
    assert.match(markdown, /Result exceeds assertion window/);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

for (const repairCase of [
  {
    name: "unknown issue IDs",
    initialIssueIds: ["I1", "I99"],
    diagnostics: {
      omittedIssueCountBeforeRepair: 1,
      unknownIssueCountBeforeRepair: 1,
      duplicateIssueCountBeforeRepair: 0,
    },
    promptPattern: /"unknownIssueIds":\["I99"\]/,
  },
  {
    name: "duplicate issue IDs",
    initialIssueIds: ["I1", "I1", "I2"],
    diagnostics: {
      omittedIssueCountBeforeRepair: 0,
      unknownIssueCountBeforeRepair: 0,
      duplicateIssueCountBeforeRepair: 1,
    },
    promptPattern: /"duplicateIssueIds":\["I1"\]/,
  },
]) {
  test(`repairs ${repairCase.name} in the same grouping session`, async () => {
    const runDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-group-reference-repair-"),
    );
    const manifest = {
      count: 1,
      runDir,
      failures: [entry("attempt__retry0", 0, "unexpected")],
    };
    const records = [record("attempt__retry0", [softIssue, terminalIssue])];
    const prompts = [];
    const responses = [
      {
        summary: "The initial response has invalid references.",
        problems: [modelProblem(repairCase.initialIssueIds)],
      },
      {
        summary: "Both issues are assigned exactly once.",
        problems: [modelProblem(["I1", "I2"])],
      },
    ];
    const client = {
      async createSession() {
        return {
          on() {
            return () => {};
          },
          async sendAndWait(options) {
            prompts.push(options.prompt);
            return {
              data: { content: JSON.stringify(responses[prompts.length - 1]) },
            };
          },
          async disconnect() {},
        };
      },
    };

    try {
      const result = await groupRun(
        client,
        runDir,
        manifest,
        records,
        "small-model",
        "big-model",
      );
      const markdown = fs.readFileSync(result.filePath, "utf8");
      assert.equal(prompts.length, 2);
      assert.match(prompts[1], repairCase.promptPattern);
      assert.equal(result.diagnostics.repairAttempted, true);
      for (const [key, value] of Object.entries(repairCase.diagnostics))
        assert.equal(result.diagnostics[key], value);
      assert.equal(result.diagnostics.omittedIssueCountAfterRepair, 0);
      assert.equal(result.diagnostics.unknownIssueCountAfterRepair, 0);
      assert.equal(result.diagnostics.duplicateIssueCountAfterRepair, 0);
      assert.doesNotMatch(markdown, /Unclassified/);
      assert.match(markdown, /\*\*Total: 1 = 1 failed attempts\*\*/);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
}

test("sanitizes unknown, duplicate, and missing IDs when repair fails", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-group-reference-fallback-"),
  );
  const manifest = {
    count: 1,
    runDir,
    failures: [entry("attempt__retry0", 0, "unexpected")],
  };
  const records = [record("attempt__retry0", [softIssue, terminalIssue])];
  let callCount = 0;
  const client = {
    async createSession() {
      return {
        on() {
          return () => {};
        },
        async sendAndWait() {
          callCount++;
          if (callCount === 2)
            return { data: { content: '{"summary":"truncated"' } };
          return {
            data: {
              content: JSON.stringify({
                summary: "The initial response has every reference defect.",
                problems: [
                  modelProblem(["I1", "I404"], { title: "Valid placement" }),
                  modelProblem(["I1"], { title: "Duplicate placement" }),
                ],
              }),
            },
          };
        },
        async disconnect() {},
      };
    },
  };

  try {
    const result = await groupRun(
      client,
      runDir,
      manifest,
      records,
      "small-model",
      "big-model",
    );
    const markdown = fs.readFileSync(result.filePath, "utf8");
    assert.equal(callCount, 2);
    assert.equal(result.problemCount, 2);
    assert.equal(result.diagnostics.omittedIssueCountBeforeRepair, 1);
    assert.equal(result.diagnostics.unknownIssueCountBeforeRepair, 1);
    assert.equal(result.diagnostics.duplicateIssueCountBeforeRepair, 1);
    assert.equal(result.diagnostics.omittedIssueCountAfterRepair, 1);
    assert.equal(result.diagnostics.unknownIssueCountAfterRepair, 0);
    assert.equal(result.diagnostics.duplicateIssueCountAfterRepair, 0);
    assert.match(markdown, /Valid placement/);
    assert.doesNotMatch(markdown, /Duplicate placement/);
    assert.doesNotMatch(markdown, /I404/);
    assert.match(markdown, /Unclassified - invalid grouping references/);
    assert.match(markdown, /\*\*Total: 1 = 1 failed attempts\*\*/);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("retains the initial partial grouping when omission repair is invalid", async () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-group-repair-error-"),
  );
  const manifest = {
    count: 1,
    runDir,
    failures: [entry("attempt__retry0", 0, "unexpected")],
  };
  const records = [record("attempt__retry0", [softIssue, terminalIssue])];
  let callCount = 0;
  const client = {
    async createSession() {
      return {
        on() {
          return () => {};
        },
        async sendAndWait() {
          callCount++;
          if (callCount === 2)
            return { data: { content: '{"summary":"truncated"' } };
          return {
            data: {
              content: JSON.stringify({
                summary: "One issue was grouped and one was omitted.",
                problems: [
                  {
                    title: "Unexpected loading controls",
                    error: "Unexpected Back button",
                    whatHappens: "The loading screen shows an extra control.",
                    rootCause: "The loading snapshot changed.",
                    issueIds: ["I1"],
                  },
                ],
              }),
            },
          };
        },
        async disconnect() {},
      };
    },
  };

  try {
    const result = await groupRun(
      client,
      runDir,
      manifest,
      records,
      "small-model",
      "big-model",
    );
    const markdown = fs.readFileSync(result.filePath, "utf8");
    assert.equal(callCount, 2);
    assert.equal(result.diagnostics.repairAttempted, true);
    assert.equal(result.diagnostics.omittedIssueCountBeforeRepair, 1);
    assert.equal(result.diagnostics.omittedIssueCountAfterRepair, 1);
    assert.match(result.diagnostics.repairErrorMessage, /JSON/);
    assert.match(markdown, /Unexpected loading controls/);
    assert.match(markdown, /Unclassified - invalid grouping references/);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("preserves grouping diagnostics when the model response is invalid", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-group-error-"));
  const manifest = {
    count: 1,
    runDir,
    failures: [entry("attempt__retry0", 0, "unexpected")],
  };
  const records = [record("attempt__retry0", [terminalIssue])];
  let disconnected = false;
  const client = {
    async createSession() {
      return {
        on(handler) {
          this.eventHandler = handler;
          return () => {};
        },
        async sendAndWait() {
          this.eventHandler({
            type: "assistant.usage",
            data: {
              model: "big-model",
              inputTokens: 1800,
              outputTokens: 128000,
              finishReason: "length",
            },
          });
          return { data: { content: '{"summary":"truncated"' } };
        },
        async disconnect() {
          disconnected = true;
        },
      };
    },
  };

  try {
    await assert.rejects(
      groupRun(client, runDir, manifest, records, "small-model", "big-model"),
      (error) => {
        assert.equal(error instanceof GroupingRunError, true);
        assert.equal(error.diagnostics.stage, "parse");
        assert.equal(error.diagnostics.inputTokens, 1800);
        assert.equal(error.diagnostics.outputTokens, 128000);
        assert.equal(error.diagnostics.finishReason, "length");
        assert.equal(error.diagnostics.responseBytes, 22);
        assert.match(error.diagnostics.errorMessage, /JSON/);
        return true;
      },
    );
    assert.equal(disconnected, true);
    assert.equal(
      fs.existsSync(path.join(runDir, "grouped-analysis.md")),
      false,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
