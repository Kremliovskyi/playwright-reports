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
  folder,
  testTitle: `tests/e2e/example.spec.ts:42 › flow › e2eFlowTC01`,
  spec: "tests/e2e/example.spec.ts:42",
  stepPath: ["Open flow", "Complete the flow"],
  failingOperation: "Click result button",
  errorVerbatim: "Timeout 10000ms exceeded",
  errorNormalized: "timeout waiting for result",
  network: [],
  issues,
  finalPageState: "The result screen is visible.",
  transientVsFinalContradiction: "none",
  rootCauseHypothesis: "The result exceeded the assertion window.",
  discriminators: "Open flow passed; completion timed out.",
  ...overrides,
});

const softIssue = {
  kind: "soft assertion",
  step: "Check loading screen",
  errorVerbatim: "Unexpected Back button",
  explanation: "The loading screen contains an extra Back button.",
};

const terminalIssue = {
  kind: "timeout",
  step: "Complete the flow",
  errorVerbatim: "Timeout 10000ms exceeded",
  explanation: "The result appeared after the assertion window.",
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
    record("failed-ai__retry0", [], { _error: "Model response was invalid" }),
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
    assert.match(
      sentOptions.prompt,
      /"failingOperation":"Click result button"/,
    );
    assert.match(
      sentOptions.prompt,
      /"discriminators":"Open flow passed; completion timed out\."/,
    );
    assert.match(
      sentOptions.prompt,
      /ancestor step names are scenario context, not standalone failure signatures/,
    );
    assert.match(
      sentOptions.prompt,
      /Differences only in those labels must not split issues/,
    );
    assert.match(
      sentOptions.prompt,
      /Do not merge solely because issues share a product, broad timeout category, missing-element category, or similar root-cause wording/,
    );
    assert.match(
      sentOptions.prompt,
      /Bias toward splitting when a material field conflicts or the evidence needed to compare the break points is missing/,
    );
    assert.equal(disconnected, true);
    assert.equal(result.problemCount, 1);
    assert.equal(result.diagnostics.stage, "complete");
    assert.equal(result.diagnostics.reasoningEffort, "high");
    assert.equal(result.diagnostics.requestCount, 1);
    assert.equal(result.diagnostics.repairAttempted, false);
    assert.equal(result.diagnostics.contextTokenLimit, 272000);
    assert.equal(result.diagnostics.inputTokens, 2200);
    assert.equal(result.diagnostics.outputTokens, 300);
    assert.equal(result.diagnostics.finishReason, "stop");
    assert.equal(fs.existsSync(path.join(runDir, "grouped-analysis.md")), true);
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
