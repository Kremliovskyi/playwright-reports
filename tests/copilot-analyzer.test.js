const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { analyzeRun } = require('../dist/copilot-analyzer');

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

const modelRecord = issues => ({
  folder: 'attempt__retry0',
  testTitle: 'tests/example.spec.ts:1 › example',
  spec: 'tests/example.spec.ts:1',
  stepPath: ['Example step'],
  deepestFailingStep: 'Example step',
  errorVerbatim: 'Error: authoritative failure',
  errorNormalized: 'authoritative failure',
  network: [],
  issues,
  finalPageState: 'Done',
  transientVsFinalContradiction: 'none',
  rootCauseHypothesis: 'The assertion failed.',
  discriminators: 'The preceding setup passed.'
});

const runAnalysis = async response => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-analyzer-'));
  const folder = 'attempt__retry0';
  fs.mkdirSync(path.join(runDir, folder));
  fs.writeFileSync(path.join(runDir, folder, 'error.md'), errorMarkdown);
  fs.writeFileSync(path.join(runDir, folder, 'failure.json'), JSON.stringify({
    testTitle: 'tests/example.spec.ts:1 › example',
    title: 'Example step',
    status: 'failed',
    outcome: 'unexpected',
    retryIndex: 0,
    issues: [{ message: 'Error: must not reach the model' }],
    actionDiagnostics: [{ message: 'Error: must not reach the model' }],
    topLevelSteps: [{
      callId: 'test.step@1',
      parentId: null,
      title: 'Example step',
      method: 'test.step',
      error: { message: 'Error: must not reach the model' },
      children: []
    }],
    files: { errorMarkdown: 'error.md' }
  }));

  let sentPrompt;
  const client = {
    async createSession() {
      return {
        async sendAndWait(options) {
          sentPrompt = options.prompt;
          return { data: { content: JSON.stringify(response) } };
        },
        async disconnect() {}
      };
    }
  };
  try {
    const result = await analyzeRun(client, runDir, {
      count: 1,
      runDir,
      failures: [{
        folder,
        testTitle: 'tests/example.spec.ts:1 › example',
        title: 'Example step',
        retryIndex: 0,
        status: 'failed',
        outcome: 'unexpected'
      }]
    }, 'small-model');
    return { result, sentPrompt };
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
};

test('uses error.md as the exclusive issue source', async () => {
  const issue = {
    kind: 'soft assertion',
    step: 'Example step',
    errorVerbatim: 'Error: authoritative failure',
    explanation: 'The authoritative assertion failed.'
  };
  const { result, sentPrompt } = await runAnalysis(modelRecord([issue]));

  assert.equal(result.analyzed, 1);
  assert.equal(result.failed, 0);
  assert.match(sentPrompt, /contains exactly 1 fenced error block/);
  assert.doesNotMatch(sentPrompt, /must not reach the model/);
  assert.match(sentPrompt, /"title": "Example step"/);
});

test('rejects a record whose issue count differs from error.md', async () => {
  const issue = {
    kind: 'soft assertion',
    step: 'Example step',
    errorVerbatim: 'Error: authoritative failure',
    explanation: 'The authoritative assertion failed.'
  };
  const { result } = await runAnalysis(modelRecord([issue, { ...issue, kind: 'trace' }]));

  assert.equal(result.analyzed, 0);
  assert.equal(result.failed, 1);
  assert.match(result.records[0]._error, /matching the error\.md issue count/);
});