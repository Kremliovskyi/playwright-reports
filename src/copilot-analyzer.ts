import fs from 'fs';
import path from 'path';
import { CopilotClient, approveAll } from '@github/copilot-sdk';

// Model used for per-trace analysis. Override with the COPILOT_ANALYSIS_MODEL env var.
// Must be a model id the logged-in Copilot CLI exposes (verify with client.listModels()).
export const COPILOT_ANALYSIS_MODEL = process.env.COPILOT_ANALYSIS_MODEL || 'gpt-5.4-mini';

// Per-trace timeout for the assistant response (ms).
const PER_TRACE_TIMEOUT_MS = 180000;

// Number of failure folders analyzed concurrently. Each folder is fully isolated
// (own input files, own Copilot session, own ai-analysis.md), so they never interfere.
const ANALYSIS_CONCURRENCY = 3;

// --- Types ---------------------------------------------------------------

export interface FailureManifestEntry {
  folder: string;
  testTitle: string | null;
  title: string;
  retryIndex: number;
  status: string;
  outcome: string;
  traceSha1?: string;
  screenshotCount?: number;
  networkErrorCount?: number;
  consoleErrorCount?: number;
}

export interface FailureManifest {
  count: number;
  runDir: string;
  failures: FailureManifestEntry[];
}

export interface UnderstandingRecordNetworkItem {
  call: string;
  status: number | null;
  gist: string;
  relToStep: string;
}

export interface UnderstandingRecord {
  folder: string;
  testTitle: string | null;
  spec: string;
  stepPath: string[];
  deepestFailingStep: string;
  errorVerbatim: string;
  errorNormalized: string;
  network: UnderstandingRecordNetworkItem[];
  // Where the page ACTUALLY ended up, per the `# Page snapshot` YAML in error.md.
  // May differ from the assertion diff's transient "Received" value (soft assertions).
  finalPageState: string;
  // Explicit cross-check between the diff's transient "Received" value and the
  // final page snapshot: "none" when they agree, otherwise a one-line description
  // (e.g. latency — flow completed after the soft-assertion window, not a stall).
  transientVsFinalContradiction: string;
  rootCauseHypothesis: string;
  discriminators: string;
  _error?: string;
  _raw?: string;
}

// The per-failure AI understanding — the record fields from `stepPath` onward
// (folder/testTitle/spec are dropped: folder/testTitle live on the manifest entry
// and the spec path is the leading `<file>:<line>` of testTitle).
export type AiAnalysis = Omit<UnderstandingRecord, 'folder' | 'testTitle' | 'spec'>;

// File name of the per-failure AI analysis written next to error.md in each folder.
export const AI_ANALYSIS_FILENAME = 'ai-analysis.md';

export interface AnalyzeRunSummary {
  total: number;
  analyzed: number;
  failed: number;
  skipped: number;
  analysisFileName: string;
}

export interface AnalyzeProgress {
  index: number;
  total: number;
  // Monotonic count of folders that have finished (done or error). Drives the
  // UI "Analyzing X/total" label so it advances steadily under concurrency.
  completed?: number;
  folder: string;
  testTitle: string | null;
  status: 'start' | 'done' | 'error';
  message?: string;
}

export interface CopilotPreflightResult {
  ok: boolean;
  authenticated: boolean;
  login?: string;
  authType?: string;
  host?: string;
  model: string;
  modelAvailable: boolean;
  availableModels: string[];
  error?: string;
}

const REQUIRED_RECORD_KEYS: (keyof UnderstandingRecord)[] = [
  'folder',
  'testTitle',
  'spec',
  'stepPath',
  'deepestFailingStep',
  'errorVerbatim',
  'errorNormalized',
  'network',
  'finalPageState',
  'transientVsFinalContradiction',
  'rootCauseHypothesis',
  'discriminators'
];

// --- Filtering -----------------------------------------------------------

// Before Hooks / skipped attempts are not real failures and must be omitted.
export const isAnalyzableEntry = (entry: FailureManifestEntry): boolean =>
  entry.testTitle !== null && entry.outcome !== 'skipped' && entry.title !== 'Before Hooks';

// Project an understanding record down to the AI-analysis fields (everything from
// `stepPath` onward; folder/testTitle/spec are dropped — see AiAnalysis).
export const toAiAnalysis = (record: UnderstandingRecord): AiAnalysis => {
  const { folder, testTitle, spec, ...aiAnalysis } = record;
  void folder;
  void testTitle;
  void spec;
  return aiAnalysis;
};

// Render an understanding record as a human-readable `ai-analysis.md`, written
// next to error.md in the failure folder. The reduce phase reads this instead of
// a separate records.json or an index.json embed.
export const renderAiAnalysisMarkdown = (record: UnderstandingRecord, model: string): string => {
  const ai = toAiAnalysis(record);
  const lines: string[] = [];

  lines.push('# AI Analysis');
  lines.push('');
  lines.push(`> Model: \`${model}\``);
  lines.push('');

  if (ai._error) {
    lines.push('> ⚠️ AI analysis failed for this folder — fall back to investigating the raw files (error.md, failure.json, screenshots) manually.');
    lines.push('');
    lines.push('## Error');
    lines.push('');
    lines.push('```');
    lines.push(ai._error);
    lines.push('```');
    if (ai._raw) {
      lines.push('');
      lines.push('## Raw response (truncated)');
      lines.push('');
      lines.push('```');
      lines.push(ai._raw);
      lines.push('```');
    }
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Step path');
  lines.push('');
  if (ai.stepPath.length) {
    for (const step of ai.stepPath) lines.push(`- ${step}`);
  } else {
    lines.push('_None_');
  }
  lines.push('');
  lines.push(`**Deepest failing step:** ${ai.deepestFailingStep || '_unknown_'}`);
  lines.push('');

  lines.push('## Error');
  lines.push('');
  lines.push(`- **Verbatim:** ${ai.errorVerbatim || '_none_'}`);
  lines.push(`- **Normalized:** ${ai.errorNormalized || '_none_'}`);
  lines.push('');

  lines.push('## Network');
  lines.push('');
  if (ai.network.length) {
    lines.push('| Call | Status | Gist | Relation to step |');
    lines.push('| --- | --- | --- | --- |');
    for (const n of ai.network) {
      lines.push(`| ${n.call} | ${n.status ?? '—'} | ${n.gist} | ${n.relToStep} |`);
    }
  } else {
    lines.push('_No network errors._');
  }
  lines.push('');

  lines.push('## Final page state');
  lines.push('');
  lines.push(ai.finalPageState || '_none_');
  lines.push('');

  lines.push('## Transient vs final check');
  lines.push('');
  lines.push(ai.transientVsFinalContradiction || '_none_');
  lines.push('');

  lines.push('## Root cause hypothesis');
  lines.push('');
  lines.push(ai.rootCauseHypothesis || '_none_');
  lines.push('');

  lines.push('## Discriminators');
  lines.push('');
  lines.push(ai.discriminators || '_none_');
  lines.push('');

  return lines.join('\n');
};

// --- Preflight -----------------------------------------------------------

const NOT_AUTHENTICATED_MESSAGE =
  'Copilot CLI is not authenticated. Run "copilot" in a terminal and sign in (or set a GITHUB_TOKEN env var for the dashboard process).';

// Create a client. When a token is provided it is used directly (gitHubToken
// takes priority over the logged-in user); otherwise the Copilot CLI login is used.
const createClient = (token?: string): CopilotClient =>
  token && token.trim() ? new CopilotClient({ gitHubToken: token.trim() }) : new CopilotClient();

// Verify the host's Copilot CLI is authenticated and the configured model is available.
// Used by the /api/copilot-status endpoint for a proactive UI check.
export const copilotPreflight = async (
  model: string = COPILOT_ANALYSIS_MODEL,
  token?: string
): Promise<CopilotPreflightResult> => {
  const client = createClient(token);
  try {
    await client.start();
    const auth = await client.getAuthStatus();
    const availableModels = (await client.listModels()).map((m) => m.id);
    const modelAvailable = availableModels.includes(model);
    const ok = auth.isAuthenticated && modelAvailable;
    let error: string | undefined;
    if (!auth.isAuthenticated) {
      error = NOT_AUTHENTICATED_MESSAGE;
    } else if (!modelAvailable) {
      error = `Model "${model}" is not available. Available: ${availableModels.join(', ')}`;
    }
    return {
      ok,
      authenticated: auth.isAuthenticated,
      login: auth.login,
      authType: auth.authType,
      host: auth.host,
      model,
      modelAvailable,
      availableModels,
      error
    };
  } catch (err) {
    return {
      ok: false,
      authenticated: false,
      model,
      modelAvailable: false,
      availableModels: [],
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    try {
      await client.stop();
    } catch {
      /* ignore stop failure */
    }
  }
};

// --- Prompt --------------------------------------------------------------

const buildPrompt = (folderName: string, errorMd: string, failureJsonText: string, networkErrorsText: string | null): string => {
  const networkSection = networkErrorsText
    ? `\n## network-errors.json (failed/relevant requests)\n\`\`\`json\n${networkErrorsText}\n\`\`\`\n`
    : '\n## network-errors.json\n(none — there were no network errors for this attempt)\n';

  return `You are investigating ONE failed Playwright test attempt and must produce a single structured JSON "understanding record". Work only from the text materials provided below. Do NOT invent facts.

The '# Page snapshot' YAML section of error.md is the authoritative record of the final rendered UI at the failure point. Trust it over the assertion diff's "Received" value, which can be a transient mid-flight state.

## Folder name
${folderName}

## error.md (primary surface: error diff, YAML page snapshot, test codeframe)
\`\`\`md
${errorMd || '(error.md not present)'}
\`\`\`

## failure.json (step tree, metadata, screenshots anchors)
\`\`\`json
${failureJsonText}
\`\`\`
${networkSection}
## Output — return EXACTLY this JSON object and NOTHING else (no prose, no markdown fences)
{
  "folder": "${folderName}",
  "testTitle": "<from failure.json>",
  "spec": "<spec file>:<line>",
  "stepPath": ["<ordered ancestor steps down to the failing one>"],
  "deepestFailingStep": "<the deepest/leaf failing step name>",
  "errorVerbatim": "<the exact error line>",
  "errorNormalized": "<short normalized form, e.g. 'timeout waiting for locator'>",
  "network": [
    { "call": "<METHOD path>", "status": <code or null>, "gist": "<one line>", "relToStep": "<how this relates to the failing step, or 'none'>" }
  ],
  "finalPageState": "<where the page ACTUALLY ended up, per the '# Page snapshot' YAML section in error.md — the final rendered UI. This may differ from the assertion diff's 'Received' value, which can be a transient mid-flight state>",
  "transientVsFinalContradiction": "<'none' if the assertion diff's Received value agrees with the final page snapshot; otherwise ONE line describing the contradiction, e.g. 'diff Received shows Processing spinner but the # Page snapshot shows the success screen — flow completed after the soft-assertion window (latency, not a stall)'>",
  "rootCauseHypothesis": "<your best one-sentence root cause>",
  "discriminators": "<CRITICAL: state precisely WHERE in the flow it broke and what would make this NOT the same as a superficially-similar failure. Name the step that PASSED just before the break, so a look-alike that breaks at a different step is distinguishable.>"
}

Rules:
- The "discriminators" field is the most important. Be specific about the exact step where the flow broke and which earlier step succeeded.
- ALWAYS read the '# Page snapshot' YAML section of error.md before writing "finalPageState" and "transientVsFinalContradiction". A failed SOFT assertion (expect.soft, short timeout) captures a transient mid-flight state in the diff's "Received" value, while the page snapshot records where the page actually ended up. If the snapshot shows the expected/success screen, the flow DID complete — classify it explicitly as latency past the assertion window, not a hard stall.
- Do not fabricate network entries — only include what network-errors.json or failure.json actually show. If none, use an empty array.
- Return ONLY the JSON object, with no surrounding text or code fences.`;
};

// --- JSON extraction / validation ---------------------------------------

const extractJson = (text: string): unknown => {
  let candidate = text.trim();

  // Strip a fenced ```json ... ``` or ``` ... ``` block if present.
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  // Fall back to the first {...} span.
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('No JSON object found in response');
    }
    candidate = candidate.slice(start, end + 1);
  }

  return JSON.parse(candidate);
};

const validateRecord = (obj: unknown): obj is UnderstandingRecord => {
  if (typeof obj !== 'object' || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  for (const key of REQUIRED_RECORD_KEYS) {
    if (!(key in rec)) return false;
  }
  if (!Array.isArray(rec.stepPath)) return false;
  if (!Array.isArray(rec.network)) return false;
  return true;
};

// --- Per-folder analysis -------------------------------------------------

const readIfExists = (filePath: string): string | null => {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  } catch {
    return null;
  }
};

// Minimal shape of a session we rely on (the SDK types these fully).
interface AnalyzerSession {
  sendAndWait(
    options: { prompt: string; attachments?: Array<{ type: string; path: string }> },
    timeout?: number
  ): Promise<{ data?: { content?: string } } | undefined>;
  disconnect(): Promise<void>;
}

interface AnalyzerClient {
  createSession(config: Record<string, unknown>): Promise<AnalyzerSession>;
}

const analyzeFolder = async (
  client: AnalyzerClient,
  runDir: string,
  entry: FailureManifestEntry,
  model: string
): Promise<UnderstandingRecord> => {
  const folderPath = path.join(runDir, entry.folder);
  const failureJsonText = fs.readFileSync(path.join(folderPath, 'failure.json'), 'utf8');
  const failureJson = JSON.parse(failureJsonText) as Record<string, unknown>;

  const files = (failureJson.files as Record<string, string | null> | undefined) || {};
  const errorMd = files.errorMarkdown ? readIfExists(path.join(folderPath, files.errorMarkdown)) || '' : readIfExists(path.join(folderPath, 'error.md')) || '';
  const networkErrorsText = files.networkErrors ? readIfExists(path.join(folderPath, files.networkErrors)) : null;

  const prompt = buildPrompt(entry.folder, errorMd, failureJsonText, networkErrorsText);

  const session = await client.createSession({ model, onPermissionRequest: approveAll });
  try {
    let result = await session.sendAndWait({ prompt }, PER_TRACE_TIMEOUT_MS);
    let content = result?.data?.content ?? '';

    let parsed: unknown;
    try {
      parsed = extractJson(content);
    } catch {
      // One corrective retry in the same session.
      result = await session.sendAndWait(
        { prompt: 'Your previous response could not be parsed as JSON. Return ONLY the JSON object described earlier, with no surrounding text or code fences.' },
        PER_TRACE_TIMEOUT_MS
      );
      content = result?.data?.content ?? '';
      parsed = extractJson(content);
    }

    if (!validateRecord(parsed)) {
      return {
        folder: entry.folder,
        testTitle: entry.testTitle,
        spec: '',
        stepPath: [],
        deepestFailingStep: '',
        errorVerbatim: '',
        errorNormalized: '',
        network: [],
        finalPageState: '',
        transientVsFinalContradiction: '',
        rootCauseHypothesis: '',
        discriminators: '',
        _error: 'Response did not contain a valid record',
        _raw: content.slice(0, 4000)
      };
    }

    // Ensure folder is correct regardless of model output.
    const record = parsed as UnderstandingRecord;
    record.folder = entry.folder;
    return record;
  } finally {
    await session.disconnect();
  }
};

// --- Run-level orchestration --------------------------------------------

export const analyzeRun = async (
  runDir: string,
  manifest: FailureManifest,
  model: string,
  onProgress?: (p: AnalyzeProgress) => void,
  token?: string
): Promise<AnalyzeRunSummary> => {
  const entries = (manifest.failures || []).filter(isAnalyzableEntry);
  const skipped = (manifest.failures || []).length - entries.length;
  const total = entries.length;

  const client = createClient(token);
  await client.start();

  // Preflight once: fail fast with a clear message instead of N per-trace errors.
  const auth = await client.getAuthStatus();
  if (!auth.isAuthenticated) {
    await client.stop();
    throw new Error(NOT_AUTHENTICATED_MESSAGE);
  }
  const availableModels = (await client.listModels()).map((m) => m.id);
  if (!availableModels.includes(model)) {
    await client.stop();
    throw new Error(`Model "${model}" is not available. Available: ${availableModels.join(', ')}`);
  }

  let analyzed = 0;
  let failed = 0;

  // Monotonic count of folders that have finished (done or error). Incremented
  // synchronously when a task completes, so the UI label advances steadily even
  // though tasks finish out of order under concurrency.
  let completed = 0;

  // Process a single failure folder in full isolation: own input files, own
  // Copilot session, own ai-analysis.md. Never throws — failures are captured
  // as an error record so one bad trace can't abort the others.
  const processEntry = async (entry: FailureManifestEntry, index: number): Promise<void> => {
    onProgress?.({ index, total, folder: entry.folder, testTitle: entry.testTitle, status: 'start' });
    try {
      const record = await analyzeFolder(client as unknown as AnalyzerClient, runDir, entry, model);
      fs.writeFileSync(path.join(runDir, entry.folder, AI_ANALYSIS_FILENAME), renderAiAnalysisMarkdown(record, model), 'utf8');
      if (record._error) {
        failed++;
        onProgress?.({ index, total, completed: ++completed, folder: entry.folder, testTitle: entry.testTitle, status: 'error', message: record._error });
      } else {
        analyzed++;
        onProgress?.({ index, total, completed: ++completed, folder: entry.folder, testTitle: entry.testTitle, status: 'done' });
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      const errorRecord: UnderstandingRecord = {
        folder: entry.folder,
        testTitle: entry.testTitle,
        spec: '',
        stepPath: [],
        deepestFailingStep: '',
        errorVerbatim: '',
        errorNormalized: '',
        network: [],
        finalPageState: '',
        transientVsFinalContradiction: '',
        rootCauseHypothesis: '',
        discriminators: '',
        _error: message
      };
      try {
        fs.writeFileSync(path.join(runDir, entry.folder, AI_ANALYSIS_FILENAME), renderAiAnalysisMarkdown(errorRecord, model), 'utf8');
      } catch {
        /* ignore write failure */
      }
      onProgress?.({ index, total, completed: ++completed, folder: entry.folder, testTitle: entry.testTitle, status: 'error', message });
    }
  };

  try {
    // Bounded worker pool: a shared cursor hands out the next entry to each of the
    // ANALYSIS_CONCURRENCY workers, which pull-and-process until the queue drains.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const i = cursor++;
        await processEntry(entries[i], i + 1);
      }
    };
    const workerCount = Math.min(ANALYSIS_CONCURRENCY, entries.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    await client.stop();
  }

  // Each analyzable failure folder now holds an `ai-analysis.md` next to error.md.
  // index.json is left untouched (no embed, no separate records.json).
  return { total, analyzed, failed, skipped, analysisFileName: AI_ANALYSIS_FILENAME };
};
