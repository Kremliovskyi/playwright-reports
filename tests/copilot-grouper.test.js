const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildGroupingAttachments,
  groupRun,
  parseGroupingResponse,
  renderGroupedAnalysis,
  validateGroupingResponse
} = require('../dist/copilot-grouper');

const entry = (folder, retryIndex, outcome, testName = 'e2eFlowTC01') => ({
  folder,
  testTitle: `tests/e2e/example.spec.ts:42 › flow › ${testName}`,
  title: 'Complete the flow',
  retryIndex,
  status: 'failed',
  outcome
});

const record = (folder, issues, overrides = {}) => ({
  folder,
  testTitle: `tests/e2e/example.spec.ts:42 › flow › e2eFlowTC01`,
  spec: 'tests/e2e/example.spec.ts:42',
  stepPath: ['Open flow', 'Complete the flow'],
  deepestFailingStep: 'Complete the flow',
  errorVerbatim: 'Timeout 10000ms exceeded',
  errorNormalized: 'timeout waiting for result',
  network: [],
  issues,
  finalPageState: 'The result screen is visible.',
  transientVsFinalContradiction: 'none',
  rootCauseHypothesis: 'The result exceeded the assertion window.',
  discriminators: 'Open flow passed; completion timed out.',
  ...overrides
});

const softIssue = {
  kind: 'soft assertion',
  step: 'Check loading screen',
  errorVerbatim: 'Unexpected Back button',
  explanation: 'The loading screen contains an extra Back button.'
};

const terminalIssue = {
  kind: 'timeout',
  step: 'Complete the flow',
  errorVerbatim: 'Timeout 10000ms exceeded',
  explanation: 'The result appeared after the assertion window.'
};

test('renders retries and secondary issues without inflating reconciliation', () => {
  const manifest = {
    count: 3,
    runDir: '/tmp/run-test',
    failures: [
      entry('attempt-a__retry0', 0, 'unexpected'),
      entry('attempt-a__retry1', 1, 'flaky'),
      { ...entry('skipped__retry0', 0, 'skipped'), outcome: 'skipped' }
    ]
  };
  const records = [
    record('attempt-a__retry0', [softIssue, terminalIssue]),
    record('attempt-a__retry1', [terminalIssue])
  ];
  const response = validateGroupingResponse({
    summary: 'One loading-state issue and one shared terminal timeout.',
    problems: [
      {
        title: 'Unexpected loading controls',
        error: 'Unexpected Back button',
        whatHappens: 'The loading screen shows an extra control.',
        rootCause: 'The loading snapshot changed | unexpectedly.',
        issueRefs: [{ folder: 'attempt-a__retry0', issueIndex: 1 }]
      },
      {
        title: 'Result exceeds assertion window',
        error: 'Timeout 10000ms exceeded',
        whatHappens: 'The result eventually appears.',
        rootCause: 'The result is slow.',
        issueRefs: [
          { folder: 'attempt-a__retry0', issueIndex: 2 },
          { folder: 'attempt-a__retry1', issueIndex: 1 }
        ]
      }
    ]
  }, records);

  const markdown = renderGroupedAnalysis('/tmp/run-test', manifest, records, response, 'small-model', 'big-model');
  assert.match(markdown, /\| 1 \| Unexpected loading controls \| 1 \| 0\*/);
  assert.match(markdown, /\| 2 \| Result exceeds assertion window \| 1 \| 2 \| 1 unexpected, 1 flaky/);
  assert.match(markdown, /retry0/);
  assert.match(markdown, /retry1/);
  assert.match(markdown, /changed \\| unexpectedly/);
  assert.match(markdown, /Problem 1 shares 1 attempt counted under Problem 2/);
  assert.match(markdown, /\*\*Total: 2 = 2 failed attempts\*\*/);
  assert.doesNotMatch(markdown, /skipped__retry0/);
});

test('rejects duplicate, missing, and unknown issue references', () => {
  const records = [record('attempt__retry0', [softIssue, terminalIssue])];
  assert.throws(() => validateGroupingResponse({
    summary: 'Duplicate',
    problems: [{
      title: 'Duplicate', error: 'error', whatHappens: 'behavior', rootCause: 'cause',
      issueRefs: [
        { folder: 'attempt__retry0', issueIndex: 1 },
        { folder: 'attempt__retry0', issueIndex: 1 }
      ]
    }]
  }, records), /more than once/);

  assert.throws(() => validateGroupingResponse({
    summary: 'Missing',
    problems: [{
      title: 'Missing', error: 'error', whatHappens: 'behavior', rootCause: 'cause',
      issueRefs: [{ folder: 'attempt__retry0', issueIndex: 1 }]
    }]
  }, records), /omitted 1 issue/);

  assert.throws(() => validateGroupingResponse({
    summary: 'Unknown',
    problems: [{
      title: 'Unknown', error: 'error', whatHappens: 'behavior', rootCause: 'cause',
      issueRefs: [{ folder: 'attempt__retry0', issueIndex: 3 }]
    }]
  }, records), /unknown issue/);
});

test('places failed per-trace records in an unclassified terminal problem', () => {
  const manifest = { count: 1, runDir: '/tmp/run-test', failures: [entry('failed-ai__retry0', 0, 'unexpected')] };
  const records = [record('failed-ai__retry0', [], { _error: 'Model response was invalid' })];
  const response = validateGroupingResponse(parseGroupingResponse(JSON.stringify({
    summary: 'One attempt could not be classified.',
    problems: []
  })), records);
  const markdown = renderGroupedAnalysis('/tmp/run-test', manifest, records, response, 'small-model', 'big-model');
  assert.match(markdown, /Unclassified - per-trace analysis unavailable/);
  assert.match(markdown, /\*\*Total: 1 = 1 failed attempts\*\*/);
});

test('attaches only index.json and analyzable ai-analysis.md files', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-grouper-'));
  try {
    const manifest = {
      count: 3,
      runDir,
      failures: [
        entry('attempt__retry0', 0, 'unexpected'),
        { ...entry('before-hooks', 0, 'unexpected'), testTitle: null, title: 'Before Hooks' },
        { ...entry('skipped__retry0', 0, 'skipped'), outcome: 'skipped' }
      ]
    };
    fs.writeFileSync(path.join(runDir, 'index.json'), JSON.stringify(manifest));
    for (const folder of ['attempt__retry0', 'before-hooks', 'skipped__retry0']) {
      fs.mkdirSync(path.join(runDir, folder));
      fs.writeFileSync(path.join(runDir, folder, 'ai-analysis.md'), '# AI Analysis');
      fs.writeFileSync(path.join(runDir, folder, 'error.md'), '# Raw error');
      fs.writeFileSync(path.join(runDir, folder, 'failure.json'), '{}');
    }

    const attachments = buildGroupingAttachments(runDir, manifest);
    assert.deepEqual(attachments.map(item => item.displayName), [
      'index.json',
      'attempt__retry0/ai-analysis.md'
    ]);
    assert.ok(attachments.every(item => item.path.endsWith('index.json') || item.path.endsWith('ai-analysis.md')));
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('uses one tool-free big-model call and writes only a validated report', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-group-run-'));
  try {
    const manifest = { count: 1, runDir, failures: [entry('attempt__retry0', 0, 'unexpected')] };
    const records = [record('attempt__retry0', [terminalIssue])];
    fs.writeFileSync(path.join(runDir, 'index.json'), JSON.stringify(manifest));
    fs.mkdirSync(path.join(runDir, 'attempt__retry0'));
    fs.writeFileSync(path.join(runDir, 'attempt__retry0', 'ai-analysis.md'), '# AI Analysis\n\n## Issues\n\n1. timeout');

    let sessionConfig;
    let callCount = 0;
    let sentAttachments;
    let disconnected = false;
    const client = {
      async createSession(config) {
        sessionConfig = config;
        return {
          async sendAndWait(options) {
            callCount += 1;
            sentAttachments = options.attachments;
            return {
              data: {
                content: JSON.stringify({
                  summary: 'One terminal timeout.',
                  problems: [{
                    title: 'Terminal timeout',
                    error: 'Timeout 10000ms exceeded',
                    whatHappens: 'The result appears too late.',
                    rootCause: 'The result exceeded the assertion window.',
                    issueRefs: [{ folder: 'attempt__retry0', issueIndex: 1 }]
                  }]
                })
              }
            };
          },
          async disconnect() {
            disconnected = true;
          }
        };
      }
    };

    const result = await groupRun(client, runDir, manifest, records, 'small-model', 'big-model');
    assert.deepEqual(sessionConfig, { model: 'big-model', availableTools: [] });
    assert.equal(callCount, 1);
    assert.deepEqual(sentAttachments.map(item => item.displayName), ['index.json', 'attempt__retry0/ai-analysis.md']);
    assert.equal(disconnected, true);
    assert.equal(result.problemCount, 1);
    assert.equal(fs.existsSync(path.join(runDir, 'grouped-analysis.md')), true);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});