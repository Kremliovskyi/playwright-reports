import fs from "fs";
import path from "path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import {
  AI_ANALYSIS_FILENAME,
  EVIDENCE_FILENAME,
  EVIDENCE_SCHEMA_VERSION,
  FailureEvidenceAttempt,
  FailureEvidenceIssue,
  FailureEvidenceRecord,
  renderEvidenceJson,
  renderEvidenceMarkdown,
  validateModelEvidenceIssues,
} from "./copilot-evidence";
import {
  applyDeterministicEvidence,
  buildDeterministicAttemptSource,
  buildDeterministicFallbackIssues,
  DeterministicAttemptSource,
  sourcePromptProjection,
} from "./copilot-source-evidence";

export {
  AI_ANALYSIS_FILENAME,
  EVIDENCE_FILENAME,
  EVIDENCE_SCHEMA_VERSION,
} from "./copilot-evidence";

// Per-trace timeout for the assistant response (ms).
const PER_TRACE_TIMEOUT_MS = 180000;

// Number of failure folders analyzed concurrently. Each folder is fully isolated
// (own input files, own Copilot session, own evidence artifacts), so they never interfere.
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

export type UnderstandingRecord = FailureEvidenceRecord;

export interface AnalyzeRunSummary {
  total: number;
  analyzed: number;
  failed: number;
  skipped: number;
  analysisFileName: string;
}

export interface AnalyzeRunResult extends AnalyzeRunSummary {
  records: FailureEvidenceRecord[];
}

export interface AnalyzeProgress {
  index: number;
  total: number;
  // Monotonic count of folders that have finished (done or error). Drives the
  // UI "Analyzing X/total" label so it advances steadily under concurrency.
  completed?: number;
  folder: string;
  testTitle: string | null;
  status: "start" | "done" | "error";
  message?: string;
}

export interface CopilotAccessResult {
  ok: boolean;
  authenticated: boolean;
  login?: string;
  authType?: string;
  host?: string;
  error?: string;
}

export interface CopilotModelsResult extends CopilotAccessResult {
  availableModels: string[];
}

export interface CopilotAnalysisModels {
  smallModel: string;
  bigModel: string;
}

export type CopilotAnalysisErrorCode =
  | "COPILOT_NOT_AUTHENTICATED"
  | "COPILOT_NO_MODELS"
  | "COPILOT_MODEL_UNAVAILABLE";

export class CopilotAnalysisError extends Error {
  constructor(
    readonly code: CopilotAnalysisErrorCode,
    message: string,
    readonly model: string,
    readonly modelRole?: "small" | "big",
  ) {
    super(message);
    this.name = "CopilotAnalysisError";
  }
}

// --- Filtering -----------------------------------------------------------

// Before Hooks / skipped attempts are not real failures and must be omitted.
export const isAnalyzableEntry = (entry: FailureManifestEntry): boolean =>
  entry.testTitle !== null &&
  entry.outcome !== "skipped" &&
  entry.title !== "Before Hooks";

export const renderAiAnalysisMarkdown = renderEvidenceMarkdown;

// --- Preflight -----------------------------------------------------------

const NOT_AUTHENTICATED_MESSAGE =
  'Copilot CLI is not authenticated. Run "copilot" in a terminal and sign in (or set a GITHUB_TOKEN env var for the dashboard process).';

// Create a client. When a token is provided it is used directly (gitHubToken
// takes priority over the logged-in user); otherwise the Copilot CLI login is used.
const createClient = (token?: string): CopilotClient =>
  token && token.trim()
    ? new CopilotClient({ gitHubToken: token.trim() })
    : new CopilotClient();

export const withCopilotAnalysisClient = async <T>(
  models: CopilotAnalysisModels,
  token: string | undefined,
  callback: (client: CopilotClient) => Promise<T>,
): Promise<T> => {
  const client = createClient(token);
  try {
    await client.start();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) {
      throw new CopilotAnalysisError(
        "COPILOT_NOT_AUTHENTICATED",
        NOT_AUTHENTICATED_MESSAGE,
        "",
      );
    }

    const availableModels = (await client.listModels()).map((item) => item.id);
    if (!availableModels.length) {
      throw new CopilotAnalysisError(
        "COPILOT_NO_MODELS",
        "No Copilot models are available for this account.",
        "",
      );
    }

    const selections: Array<{
      role: "small" | "big";
      label: string;
      model: string;
    }> = [
      { role: "small", label: "Small model", model: models.smallModel },
      { role: "big", label: "Big model", model: models.bigModel },
    ];
    for (const selection of selections) {
      if (!selection.model || !availableModels.includes(selection.model)) {
        const message = selection.model
          ? `${selection.label} "${selection.model}" is not available. Select another model in Preferences > Copilot.`
          : `${selection.label} is not selected. Select it in Preferences > Copilot.`;
        throw new CopilotAnalysisError(
          "COPILOT_MODEL_UNAVAILABLE",
          message,
          selection.model,
          selection.role,
        );
      }
    }

    return await callback(client);
  } finally {
    try {
      await client.stop();
    } catch {
      /* ignore stop failure */
    }
  }
};

// Verify that Copilot is accessible. The header status chip calls this without
// listing or selecting models, so checking access can never mutate config.
export const copilotAccessCheck = async (
  token?: string,
): Promise<CopilotAccessResult> => {
  const client = createClient(token);
  try {
    await client.start();
    const auth = await client.getAuthStatus();
    return {
      ok: auth.isAuthenticated,
      authenticated: auth.isAuthenticated,
      login: auth.login,
      authType: auth.authType,
      host: auth.host,
      error: auth.isAuthenticated ? undefined : NOT_AUTHENTICATED_MESSAGE,
    };
  } catch (err) {
    return {
      ok: false,
      authenticated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      await client.stop();
    } catch {
      /* ignore stop failure */
    }
  }
};

// List models only when Preferences opens a model picker.
export const copilotModels = async (
  token?: string,
): Promise<CopilotModelsResult> => {
  const client = createClient(token);
  try {
    await client.start();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) {
      return {
        ok: false,
        authenticated: false,
        availableModels: [],
        error: NOT_AUTHENTICATED_MESSAGE,
      };
    }
    const availableModels = (await client.listModels()).map((item) => item.id);
    return {
      ok: availableModels.length > 0,
      authenticated: true,
      login: auth.login,
      authType: auth.authType,
      host: auth.host,
      availableModels,
      error: availableModels.length
        ? undefined
        : "No Copilot models are available for this account.",
    };
  } catch (err) {
    return {
      ok: false,
      authenticated: false,
      availableModels: [],
      error: err instanceof Error ? err.message : String(err),
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

export const errorDetailBlocks = (errorMd: string): string[] => {
  const heading = errorMd.match(/^# Error details\s*$/m);
  if (!heading?.index && heading?.index !== 0) return [];
  const sectionStart = heading.index + heading[0].length;
  const remainder = errorMd.slice(sectionStart);
  const nextHeading = remainder.search(/^# (?:Page snapshot|Test source)\s*$/m);
  const section =
    nextHeading === -1 ? remainder : remainder.slice(0, nextHeading);
  return [...section.matchAll(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm)].map(
    (match) => match[1].trim(),
  );
};

const failureMetadata = (failureJsonText: string): string => {
  const failure = JSON.parse(failureJsonText) as Record<string, unknown>;
  const sanitizeStep = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const step = value as Record<string, unknown>;
    const { error, children, ...metadata } = step;
    return {
      ...metadata,
      result: error
        ? "failed"
        : typeof step.endTime === "number"
          ? "passed"
          : "incomplete",
      children: Array.isArray(children) ? children.map(sanitizeStep) : [],
    };
  };
  return JSON.stringify(
    {
      schemaVersion: failure.schemaVersion,
      testTitle: failure.testTitle,
      title: failure.title,
      status: failure.status,
      outcome: failure.outcome,
      durationMs: failure.durationMs,
      retryIndex: failure.retryIndex,
      traceSha1: failure.traceSha1,
      topLevelSteps: Array.isArray(failure.topLevelSteps)
        ? failure.topLevelSteps.map(sanitizeStep)
        : [],
      screenshots: failure.screenshots,
      files: failure.files,
    },
    null,
    2,
  );
};

const buildPrompt = (
  folderName: string,
  errorMd: string,
  failureJsonText: string,
  networkErrorsText: string | null,
  source: DeterministicAttemptSource,
): string => {
  const expectedIssueCount = errorDetailBlocks(errorMd).length;
  const networkSection = networkErrorsText
    ? `\n## network-errors.json (failed/relevant requests)\n\`\`\`json\n${networkErrorsText}\n\`\`\`\n`
    : "\n## network-errors.json\n(none — there were no network errors for this attempt)\n";

  return `You are extracting canonical evidence from ONE failed Playwright test attempt. Work only from the text materials provided below. Do NOT invent facts.

error.md is the EXCLUSIVE source of issues. It contains exactly ${expectedIssueCount} fenced error block${expectedIssueCount === 1 ? "" : "s"} under "# Error details". Return exactly ${expectedIssueCount} issue entr${expectedIssueCount === 1 ? "y" : "ies"}, one per block and in the same order. The final block is the terminal failure that ended the attempt.

The failure metadata is SUPPORTING CONTEXT ONLY. Use it for issue-local step ancestry and operation context. It intentionally excludes diagnostic collections and step error payloads. Never create an issue from metadata, parent steps, source code, network, or console entries. A parent test.step can repeat a child's error and is not another issue.

The application has already parsed source-owned facts into the deterministic source projection below. Treat its error line, operation, target, ARIA removed/added lines, state-label candidates, resolution-evidence candidates, and final-page summary as authoritative. Do not reinterpret an unchanged ARIA context line as removed content. You return only contextual facts that require semantic reading and a constrained interpretation; the application derives source references and all canonical keys.

The '# Page snapshot' YAML section is the LAST-SEEN rendered UI and belongs to the TERMINAL issue only. Never explain a non-terminal issue using the final page snapshot.

previousPassedBoundary is the nearest factually supported successful boundary before THIS issue, or null. transitionBoundary must be one exact value from boundaryCandidates in the deterministic source projection, or null. expectedStateLabel and observedStateLabel must be exact labels present in this issue's block (or the terminal page for the terminal issue), or null. rootCauseHypothesis must be null unless the supplied evidence directly supports a cause.

Issue role describes ONLY the relationship between issues in this same attempt:
- primary: this issue establishes a state or condition that causes a later issue.
- downstream: an earlier issue already established the condition that causes this issue; causedByBlockIndex is required.
- independent: no causal relationship to another issue is proven. A single-issue attempt is normally independent.

Failure type is not a role. ARIA content, locator timeout, and response-contract categories are derived by the application as failureFamily.

Resolution describes ONLY what source-backed evidence from this same attempt proves after the issue:
- recovered-in-attempt: a provided final-page or later-passed-step candidate clearly verifies that this issue's failed condition later met the expected state.
- persisted: a provided final-page or later-passed-step candidate clearly verifies that this issue's failed condition remained.
- unknown: no candidate proves either outcome. Use resolutionEvidence null.
For recovered-in-attempt or persisted, copy one exact value from this issue's resolutionEvidenceCandidates into resolutionEvidence. A passed step is evidence only when its title specifically verifies the same failed condition; merely continuing after expect.soft is not recovery. For an immutable API response mismatch, use unknown unless a later request/assertion candidate explicitly rechecks that contract. Never infer recovery from another retry or attempt.

Examples using fictional data:
1. Block 1 expects "Account Overview" but observes "Consent Review", then block 2 times out waiting for "Download Statement" on that same page. Mark block 1 primary and block 2 downstream with causedByBlockIndex 1. Resolution is persisted only on terminal block 2 when the final page still shows Consent Review.
2. A single ARIA issue misses "Note: Bring the original document" and the final page later says "Submission complete". Mark the issue independent with resolution recovered-in-attempt. Its failure type remains application-owned aria-snapshot-mismatch.
3. An API soft assertion receives status 503 instead of 200. A later candidate named "Verify API status recovered to 200" can support recovered-in-attempt when it clearly rechecks that response contract. An unrelated passed cleanup step cannot. With no proving candidate, use unknown.

## Folder name
${folderName}

## error.md (primary surface: error diff, YAML page snapshot, test codeframe)
\`\`\`md
${errorMd || "(error.md not present)"}
\`\`\`

## failure metadata (supporting step tree and identifiers; NOT an issue source)
\`\`\`json
${failureMetadata(failureJsonText)}
\`\`\`
${networkSection}
## deterministic source projection (application-owned facts)
\`\`\`json
${JSON.stringify(sourcePromptProjection(source), null, 2)}
\`\`\`

## Output — return EXACTLY this JSON object and NOTHING else (no prose, no markdown fences)
{
  "schemaVersion": ${EVIDENCE_SCHEMA_VERSION},
  "issues": [
    {
      "blockIndex": 1,
      "context": {
        "stepPath": ["<ordered named test.step ancestry for THIS issue>"],
        "previousPassedBoundary": "<nearest known successful boundary before THIS issue, or null>",
        "expected": ["<non-ARIA expected fact not already parsed by the application>"],
        "received": ["<non-ARIA received fact not already parsed by the application>"],
        "network": [
          { "call": "<METHOD path>", "status": null, "gist": "<one line>", "relToIssue": "<relationship to THIS issue>" }
        ]
      },
      "interpretation": {
        "expectedStateLabel": "<exact expected state label from source, or null>",
        "observedStateLabel": "<exact observed state label from source, or null>",
        "role": "<'primary' | 'downstream' | 'independent'>",
        "causedByBlockIndex": null,
        "resolution": "<'persisted' | 'recovered-in-attempt' | 'unknown'>",
        "resolutionEvidence": "<exact value from this issue's resolutionEvidenceCandidates, or null>",
        "transitionBoundary": "<nearest action or handoff where expected and observed states diverged, or null>",
        "explanation": "<1-2 factual sentences about THIS block>",
        "rootCauseHypothesis": "<issue-local hypothesis, or null>",
        "confidence": "<'high' | 'medium' | 'low'>",
        "ambiguities": ["<missing or conflicting evidence>"]
      }
    }
  ]
}

Rules:
- "issues" MUST contain exactly ${expectedIssueCount} entries in block order. blockIndex is 1-based, and terminal is true ONLY for the final entry.
- Do not return terminal, source references, source quotes, ARIA diffs, finalPageState, or normalization keys; the application owns them.
- Keep context and interpretation issue-local. Never attach a terminal page state or cause to an earlier issue.
- Assign non-unknown resolution only when one exact resolutionEvidenceCandidate clearly proves the same failed condition. A non-terminal soft assertion may use a later-passed-step candidate; only the terminal issue may use final-page evidence.
- downstream must reference an earlier issue through causedByBlockIndex. primary and independent must use null.
- ARIA expected/received facts come only from deterministic removed/added arrays. Do not repeat or reinterpret them in context.expected/context.received.
- Do not fabricate network entries. Use an empty array when no failed request is relevant to THIS issue.
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
  if (!candidate.startsWith("{")) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("No JSON object found in response");
    }
    candidate = candidate.slice(start, end + 1);
  }

  return JSON.parse(candidate);
};

const hydrateModelEvidence = (
  value: unknown,
  source: DeterministicAttemptSource,
): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.issues)) return value;
  return {
    schemaVersion: response.schemaVersion,
    issues: response.issues.map((rawIssue, index) => {
      const issue =
        typeof rawIssue === "object" && rawIssue !== null
          ? (rawIssue as Record<string, unknown>)
          : {};
      const context =
        typeof issue.context === "object" && issue.context !== null
          ? (issue.context as Record<string, unknown>)
          : {};
      const issueSource = source.issues[index];
      return {
        blockIndex: issue.blockIndex,
        terminal: index === source.issues.length - 1,
        facts: {
          kind: issueSource?.kind || "failure",
          assertion: issueSource?.assertion || null,
          operation: issueSource?.operation || null,
          target: issueSource?.target || null,
          stepPath: context.stepPath,
          previousPassedBoundary: context.previousPassedBoundary,
          errorVerbatim: issueSource?.errorLine || "",
          expected: context.expected,
          received: context.received,
          network: context.network,
          finalPageState:
            index === source.issues.length - 1 ? source.finalPageState : null,
          blockQuotes: [],
          sourceRefs: [],
          ariaDiff: null,
        },
        normalization: {
          failureFamily: "application-owned",
          operationKey: null,
          targetKey: null,
          normalizedError: issueSource?.errorLine || "",
          differenceKeys: [],
          volatileValuesRemoved: [],
          expectedStateKey: null,
          observedStateKey: null,
          transitionBoundaryKey: null,
        },
        interpretation: issue.interpretation,
      };
    }),
  };
};

const buildCorrectionPrompt = (
  error: unknown,
  source: DeterministicAttemptSource,
): string => `Your previous evidence JSON was rejected by deterministic validation:
${error instanceof Error ? error.message : String(error)}

Return the COMPLETE corrected JSON object using the original schema, not a patch. Return JSON only.

Correction rules:
- Keep exactly ${source.issues.length} issues in source-block order and return only context plus interpretation using the original response schema.
- Do not return application-owned structural facts or canonical keys.
- State labels must appear exactly in the deterministic source projection.
- transitionBoundary must exactly match one application-provided boundary candidate or be null.
- downstream requires causedByBlockIndex pointing to an earlier block; primary and independent require null.
- recovered-in-attempt and persisted require one exact application-provided resolutionEvidenceCandidate that proves the same condition; otherwise use unknown and null.
- Do not change evidence merely to satisfy validation; use null, [], and ambiguities when the source does not support a claim.

<deterministic-source-projection-json>
${JSON.stringify(sourcePromptProjection(source))}
</deterministic-source-projection-json>`;

// --- Per-folder analysis -------------------------------------------------

const readIfExists = (filePath: string): string | null => {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  } catch {
    return null;
  }
};

const resolveWithin = (
  rootDir: string,
  relativePath: string,
  label: string,
): string => {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, relativePath);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`))
    throw new Error(`${label} resolves outside its allowed directory`);
  if (fs.existsSync(candidate)) {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    if (!realCandidate.startsWith(`${realRoot}${path.sep}`))
      throw new Error(`${label} resolves outside its allowed directory`);
  }
  return candidate;
};

// Minimal shape of a session we rely on (the SDK types these fully).
interface AnalyzerSession {
  sendAndWait(
    options: {
      prompt: string;
      attachments?: Array<{ type: string; path: string }>;
    },
    timeout?: number,
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
  model: string,
): Promise<FailureEvidenceRecord> => {
  const folderPath = resolveWithin(runDir, entry.folder, "Failure folder");
  const failureJsonText = fs.readFileSync(
    resolveWithin(folderPath, "failure.json", "Failure metadata file"),
    "utf8",
  );
  const failureJson = JSON.parse(failureJsonText) as Record<string, unknown>;

  const files =
    (failureJson.files as Record<string, string | null> | undefined) || {};
  const errorMd =
    readIfExists(
      resolveWithin(folderPath, "error.md", "Error evidence file"),
    ) || "";
  const networkErrorsText = files.networkErrors
    ? readIfExists(
        resolveWithin(folderPath, files.networkErrors, "Network evidence file"),
      )
    : null;

  const errorBlocks = errorDetailBlocks(errorMd);
  const source = buildDeterministicAttemptSource(
    errorMd,
    errorBlocks,
    failureJsonText,
  );
  const prompt = buildPrompt(
    entry.folder,
    errorMd,
    failureJsonText,
    networkErrorsText,
    source,
  );
  const failureTitle = failureJson.testTitle;
  const attempt: FailureEvidenceAttempt = {
    folder: entry.folder,
    testTitle: entry.testTitle,
    spec:
      typeof failureTitle === "string"
        ? failureTitle.match(/^(.+\.(?:spec|test)\.[cm]?[jt]sx?:\d+)/)?.[1] ||
          ""
        : "",
    retryIndex: entry.retryIndex,
    status: entry.status,
    outcome: entry.outcome,
  };
  if (!errorBlocks.length) {
    return {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      model,
      attempt,
      issues: [],
      error: "error.md contains no fenced error blocks",
    };
  }

  const session = await client.createSession({
    model,
    onPermissionRequest: approveAll,
  });
  try {
    let result = await session.sendAndWait({ prompt }, PER_TRACE_TIMEOUT_MS);
    let content = result?.data?.content ?? "";
    let issues: FailureEvidenceIssue[];
    try {
      const hydrated = hydrateModelEvidence(extractJson(content), source);
      issues = applyDeterministicEvidence(
        validateModelEvidenceIssues(hydrated, errorBlocks),
        source,
      );
    } catch (initialError) {
      result = await session.sendAndWait(
        { prompt: buildCorrectionPrompt(initialError, source) },
        PER_TRACE_TIMEOUT_MS,
      );
      content = result?.data?.content ?? "";
      try {
        const hydrated = hydrateModelEvidence(extractJson(content), source);
        issues = applyDeterministicEvidence(
          validateModelEvidenceIssues(hydrated, errorBlocks),
          source,
        );
      } catch (correctionError) {
        return {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          model,
          attempt,
          issues: buildDeterministicFallbackIssues(source),
          warning: `Small-model interpretation unavailable after correction; deterministic source evidence retained. ${correctionError instanceof Error ? correctionError.message : String(correctionError)}`,
          rawResponse: content.slice(0, 4000),
        };
      }
    }

    return {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      model,
      attempt,
      issues,
    };
  } finally {
    await session.disconnect();
  }
};

const writeEvidenceArtifacts = (
  runDir: string,
  folder: string,
  record: FailureEvidenceRecord,
): void => {
  const folderPath = resolveWithin(runDir, folder, "Failure folder");
  fs.writeFileSync(
    resolveWithin(folderPath, EVIDENCE_FILENAME, "Evidence output file"),
    renderEvidenceJson(record),
    "utf8",
  );
  fs.writeFileSync(
    resolveWithin(folderPath, AI_ANALYSIS_FILENAME, "Analysis output file"),
    renderEvidenceMarkdown(record),
    "utf8",
  );
};

// --- Run-level orchestration --------------------------------------------

export const analyzeRun = async (
  client: CopilotClient,
  runDir: string,
  manifest: FailureManifest,
  model: string,
  onProgress?: (p: AnalyzeProgress) => void,
): Promise<AnalyzeRunResult> => {
  const entries = (manifest.failures || []).filter(isAnalyzableEntry);
  const skipped = (manifest.failures || []).length - entries.length;
  const total = entries.length;

  let analyzed = 0;
  let failed = 0;
  const records: FailureEvidenceRecord[] = new Array(total);

  // Monotonic count of folders that have finished (done or error). Incremented
  // synchronously when a task completes, so the UI label advances steadily even
  // though tasks finish out of order under concurrency.
  let completed = 0;

  // Process a single failure folder in full isolation: own input files, own
  // Copilot session and evidence files. Never throws — failures are captured
  // as an error record so one bad trace can't abort the others.
  const processEntry = async (
    entry: FailureManifestEntry,
    index: number,
  ): Promise<void> => {
    onProgress?.({
      index,
      total,
      folder: entry.folder,
      testTitle: entry.testTitle,
      status: "start",
    });
    try {
      const record = await analyzeFolder(
        client as unknown as AnalyzerClient,
        runDir,
        entry,
        model,
      );
      records[index - 1] = record;
      writeEvidenceArtifacts(runDir, entry.folder, record);
      if (record.error) {
        failed++;
        onProgress?.({
          index,
          total,
          completed: ++completed,
          folder: entry.folder,
          testTitle: entry.testTitle,
          status: "error",
          message: record.error,
        });
      } else {
        analyzed++;
        onProgress?.({
          index,
          total,
          completed: ++completed,
          folder: entry.folder,
          testTitle: entry.testTitle,
          status: "done",
        });
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      const errorRecord: FailureEvidenceRecord = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        model,
        attempt: {
          folder: entry.folder,
          testTitle: entry.testTitle,
          spec: "",
          retryIndex: entry.retryIndex,
          status: entry.status,
          outcome: entry.outcome,
        },
        issues: [],
        error: message,
      };
      records[index - 1] = errorRecord;
      try {
        writeEvidenceArtifacts(runDir, entry.folder, errorRecord);
      } catch {
        /* ignore write failure */
      }
      onProgress?.({
        index,
        total,
        completed: ++completed,
        folder: entry.folder,
        testTitle: entry.testTitle,
        status: "error",
        message,
      });
    }
  };

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

  // Each analyzable failure folder now holds canonical evidence.json and its
  // deterministic ai-analysis.md view next to error.md. index.json is untouched.
  return {
    total,
    analyzed,
    failed,
    skipped,
    analysisFileName: AI_ANALYSIS_FILENAME,
    records,
  };
};
