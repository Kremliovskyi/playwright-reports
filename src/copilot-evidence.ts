export const EVIDENCE_SCHEMA_VERSION = 3;
export const EVIDENCE_FILENAME = "evidence.json";
export const AI_ANALYSIS_FILENAME = "ai-analysis.md";

export type EvidenceConfidence = "high" | "medium" | "low";
export type EvidenceIssueRole = "primary" | "downstream" | "independent";
export type EvidenceIssueResolution =
  | "persisted"
  | "recovered-in-attempt"
  | "unknown";

export interface FailureEvidenceSourceLine {
  id: string;
  text: string;
}

export interface FailureEvidenceAriaDiff {
  removed: FailureEvidenceSourceLine[];
  added: FailureEvidenceSourceLine[];
}

export interface FailureEvidenceNetworkItem {
  call: string;
  status: number | null;
  gist: string;
  relToIssue: string;
}

export interface FailureEvidenceFacts {
  kind: string;
  assertion: string | null;
  operation: string | null;
  target: string | null;
  stepPath: string[];
  previousPassedBoundary: string | null;
  errorVerbatim: string;
  expected: string[];
  received: string[];
  network: FailureEvidenceNetworkItem[];
  finalPageState: string | null;
  blockQuotes: string[];
  sourceRefs: string[];
  ariaDiff: FailureEvidenceAriaDiff | null;
}

export interface FailureEvidenceNormalization {
  failureFamily: string;
  operationKey: string | null;
  targetKey: string | null;
  normalizedError: string;
  differenceKeys: string[];
  volatileValuesRemoved: string[];
  expectedStateKey: string | null;
  observedStateKey: string | null;
  transitionBoundaryKey: string | null;
}

export interface FailureEvidenceInterpretation {
  expectedStateLabel: string | null;
  observedStateLabel: string | null;
  role: EvidenceIssueRole;
  causedByBlockIndex: number | null;
  resolution: EvidenceIssueResolution;
  resolutionEvidence: string | null;
  transitionBoundary: string | null;
  explanation: string;
  rootCauseHypothesis: string | null;
  confidence: EvidenceConfidence;
  ambiguities: string[];
}

export interface FailureEvidenceIssue {
  blockIndex: number;
  terminal: boolean;
  facts: FailureEvidenceFacts;
  normalization: FailureEvidenceNormalization;
  interpretation: FailureEvidenceInterpretation;
}

export interface FailureEvidenceAttempt {
  folder: string;
  testTitle: string | null;
  spec: string;
  retryIndex: number;
  status: string;
  outcome: string;
}

export interface FailureEvidenceRecord {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  model: string;
  attempt: FailureEvidenceAttempt;
  issues: FailureEvidenceIssue[];
  error?: string;
  warning?: string;
  rawResponse?: string;
}

const isString = (value: unknown): value is string => typeof value === "string";

const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isNetworkItem = (value: unknown): value is FailureEvidenceNetworkItem => {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    isString(item.call) &&
    (item.status === null || typeof item.status === "number") &&
    isString(item.gist) &&
    isString(item.relToIssue)
  );
};

const isSourceLine = (value: unknown): value is FailureEvidenceSourceLine => {
  if (typeof value !== "object" || value === null) return false;
  const line = value as Record<string, unknown>;
  return isString(line.id) && isString(line.text);
};

const isAriaDiff = (value: unknown): value is FailureEvidenceAriaDiff => {
  if (typeof value !== "object" || value === null) return false;
  const diff = value as Record<string, unknown>;
  return (
    Array.isArray(diff.removed) &&
    diff.removed.every(isSourceLine) &&
    Array.isArray(diff.added) &&
    diff.added.every(isSourceLine)
  );
};

const issueRoles = new Set<EvidenceIssueRole>([
  "primary",
  "downstream",
  "independent",
]);

const issueResolutions = new Set<EvidenceIssueResolution>([
  "persisted",
  "recovered-in-attempt",
  "unknown",
]);

const valueType = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const issueSchemaError = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return "must be an object";
  const issue = value as Record<string, unknown>;
  if (!Number.isInteger(issue.blockIndex))
    return "blockIndex must be an integer";
  if (typeof issue.terminal !== "boolean") return "terminal must be a boolean";
  if (typeof issue.facts !== "object" || issue.facts === null)
    return "facts must be an object";
  if (typeof issue.normalization !== "object" || issue.normalization === null)
    return "normalization must be an object";
  if (typeof issue.interpretation !== "object" || issue.interpretation === null)
    return "interpretation must be an object";

  const facts = issue.facts as Record<string, unknown>;
  const normalization = issue.normalization as Record<string, unknown>;
  const interpretation = issue.interpretation as Record<string, unknown>;
  const checks: Array<[string, unknown, boolean, string]> = [
    ["facts.kind", facts.kind, isString(facts.kind), "a string"],
    [
      "facts.assertion",
      facts.assertion,
      isNullableString(facts.assertion),
      "a string or null",
    ],
    [
      "facts.operation",
      facts.operation,
      isNullableString(facts.operation),
      "a string or null",
    ],
    [
      "facts.target",
      facts.target,
      isNullableString(facts.target),
      "a string or null",
    ],
    [
      "facts.stepPath",
      facts.stepPath,
      isStringArray(facts.stepPath),
      "an array of strings",
    ],
    [
      "facts.previousPassedBoundary",
      facts.previousPassedBoundary,
      isNullableString(facts.previousPassedBoundary),
      "a string or null",
    ],
    [
      "facts.errorVerbatim",
      facts.errorVerbatim,
      isString(facts.errorVerbatim),
      "a string",
    ],
    [
      "facts.expected",
      facts.expected,
      isStringArray(facts.expected),
      "an array of strings",
    ],
    [
      "facts.received",
      facts.received,
      isStringArray(facts.received),
      "an array of strings",
    ],
    ["facts.network", facts.network, Array.isArray(facts.network), "an array"],
    [
      "facts.finalPageState",
      facts.finalPageState,
      isNullableString(facts.finalPageState),
      "a string or null",
    ],
    [
      "facts.blockQuotes",
      facts.blockQuotes,
      isStringArray(facts.blockQuotes),
      "an array of strings",
    ],
    [
      "facts.sourceRefs",
      facts.sourceRefs,
      isStringArray(facts.sourceRefs),
      "an array of strings",
    ],
    [
      "facts.ariaDiff",
      facts.ariaDiff,
      facts.ariaDiff === null || isAriaDiff(facts.ariaDiff),
      "an ARIA diff or null",
    ],
    [
      "normalization.failureFamily",
      normalization.failureFamily,
      isString(normalization.failureFamily),
      "a string",
    ],
    [
      "normalization.operationKey",
      normalization.operationKey,
      isNullableString(normalization.operationKey),
      "a string or null",
    ],
    [
      "normalization.targetKey",
      normalization.targetKey,
      isNullableString(normalization.targetKey),
      "a string or null",
    ],
    [
      "normalization.normalizedError",
      normalization.normalizedError,
      isString(normalization.normalizedError),
      "a string",
    ],
    [
      "normalization.differenceKeys",
      normalization.differenceKeys,
      isStringArray(normalization.differenceKeys),
      "an array of strings",
    ],
    [
      "normalization.volatileValuesRemoved",
      normalization.volatileValuesRemoved,
      isStringArray(normalization.volatileValuesRemoved),
      "an array of strings",
    ],
    [
      "normalization.expectedStateKey",
      normalization.expectedStateKey,
      isNullableString(normalization.expectedStateKey),
      "a string or null",
    ],
    [
      "normalization.observedStateKey",
      normalization.observedStateKey,
      isNullableString(normalization.observedStateKey),
      "a string or null",
    ],
    [
      "normalization.transitionBoundaryKey",
      normalization.transitionBoundaryKey,
      isNullableString(normalization.transitionBoundaryKey),
      "a string or null",
    ],
    [
      "interpretation.expectedStateLabel",
      interpretation.expectedStateLabel,
      isNullableString(interpretation.expectedStateLabel),
      "a string or null",
    ],
    [
      "interpretation.observedStateLabel",
      interpretation.observedStateLabel,
      isNullableString(interpretation.observedStateLabel),
      "a string or null",
    ],
    [
      "interpretation.causedByBlockIndex",
      interpretation.causedByBlockIndex,
      interpretation.causedByBlockIndex === null ||
        Number.isInteger(interpretation.causedByBlockIndex),
      "an integer or null",
    ],
    [
      "interpretation.resolutionEvidence",
      interpretation.resolutionEvidence,
      isNullableString(interpretation.resolutionEvidence),
      "a string or null",
    ],
    [
      "interpretation.transitionBoundary",
      interpretation.transitionBoundary,
      isNullableString(interpretation.transitionBoundary),
      "a string or null",
    ],
    [
      "interpretation.explanation",
      interpretation.explanation,
      isString(interpretation.explanation),
      "a string",
    ],
    [
      "interpretation.rootCauseHypothesis",
      interpretation.rootCauseHypothesis,
      isNullableString(interpretation.rootCauseHypothesis),
      "a string or null",
    ],
    [
      "interpretation.ambiguities",
      interpretation.ambiguities,
      isStringArray(interpretation.ambiguities),
      "an array of strings",
    ],
  ];
  const invalid = checks.find(([, , valid]) => !valid);
  if (invalid)
    return `${invalid[0]} must be ${invalid[3]}; received ${valueType(invalid[1])}`;
  if (!(facts.network as unknown[]).every(isNetworkItem))
    return "facts.network entries must contain string call/gist/relToIssue and numeric-or-null status";
  if (!issueRoles.has(interpretation.role as EvidenceIssueRole)) {
    return "interpretation.role is not an allowed value";
  }
  if (
    !issueResolutions.has(interpretation.resolution as EvidenceIssueResolution)
  ) {
    return "interpretation.resolution is not an allowed value";
  }
  if (
    interpretation.confidence !== "high" &&
    interpretation.confidence !== "medium" &&
    interpretation.confidence !== "low"
  ) {
    return "interpretation.confidence must be high, medium, or low";
  }
  return null;
};

export const validateModelEvidenceIssues = (
  value: unknown,
  errorBlocks: string[],
): FailureEvidenceIssue[] => {
  if (!errorBlocks.length)
    throw new Error("error.md contains no fenced error blocks");
  if (typeof value !== "object" || value === null)
    throw new Error("Evidence response is not an object");
  const response = value as Record<string, unknown>;
  if (response.schemaVersion !== EVIDENCE_SCHEMA_VERSION)
    throw new Error(
      `Evidence response schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`,
    );
  if (!Array.isArray(response.issues))
    throw new Error("Evidence response issues must be an array");
  response.issues.forEach((issue, index) => {
    const schemaError = issueSchemaError(issue);
    if (schemaError)
      throw new Error(`Evidence issue ${index + 1} ${schemaError}`);
  });
  const issues = response.issues as FailureEvidenceIssue[];
  if (issues.length !== errorBlocks.length) {
    throw new Error(
      `Evidence response has ${issues.length} issues for ${errorBlocks.length} error.md blocks`,
    );
  }

  issues.forEach((issue, index) => {
    const expectedBlockIndex = index + 1;
    const expectedTerminal = expectedBlockIndex === errorBlocks.length;
    if (issue.blockIndex !== expectedBlockIndex)
      throw new Error(
        `Evidence issue ${expectedBlockIndex} has wrong blockIndex`,
      );
    if (issue.terminal !== expectedTerminal)
      throw new Error(
        `Evidence issue ${expectedBlockIndex} has wrong terminal marker`,
      );
    if (!expectedTerminal) {
      if (issue.facts.finalPageState !== null) {
        throw new Error(
          `Non-terminal evidence issue ${expectedBlockIndex} contains terminal page state`,
        );
      }
    }
  });

  return issues;
};

export const renderEvidenceJson = (record: FailureEvidenceRecord): string =>
  `${JSON.stringify(record, null, 2)}\n`;

const display = (value: string | null): string => value || "_unknown_";

const renderList = (values: string[]): string =>
  values.length
    ? values.map((value) => `  - ${value}`).join("\n")
    : "  - _none_";

export const renderEvidenceMarkdown = (
  record: FailureEvidenceRecord,
): string => {
  const lines = [
    "# AI Analysis",
    "",
    `> Model: \`${record.model}\`; evidence schema: \`${record.schemaVersion}\``,
    "",
  ];

  if (record.error) {
    lines.push(
      "> ⚠️ AI evidence extraction failed for this folder — investigate error.md and the raw companion files.",
      "",
      "## Error",
      "",
      "```",
      record.error,
      "```",
    );
    if (record.rawResponse) {
      lines.push(
        "",
        "## Raw response (truncated)",
        "",
        "```",
        record.rawResponse,
        "```",
      );
    }
    lines.push("");
    return lines.join("\n");
  }

  if (record.warning) {
    lines.push(`> ⚠️ ${record.warning}`, "");
  }

  lines.push(
    "## Attempt",
    "",
    `- **Test:** ${record.attempt.testTitle || "_unknown_"}`,
    `- **Spec:** ${record.attempt.spec || "_unknown_"}`,
    `- **Retry:** ${record.attempt.retryIndex}`,
    `- **Outcome:** ${record.attempt.outcome}`,
    "",
  );

  const terminalIssue = record.issues.find((issue) => issue.terminal);
  if (terminalIssue) {
    const { facts, normalization, interpretation } = terminalIssue;
    lines.push("## Step path", "");
    if (facts.stepPath.length) {
      for (const step of facts.stepPath) lines.push(`- ${step}`);
    } else {
      lines.push("_None_");
    }
    lines.push(
      "",
      `**Failing operation:** ${display(facts.operation)}`,
      "",
      "## Error",
      "",
      `- **Verbatim:** ${facts.errorVerbatim}`,
      `- **Normalized:** ${normalization.normalizedError}`,
      "",
      "## Network",
      "",
    );
    if (facts.network.length) {
      lines.push(
        "| Call | Status | Gist | Relation to issue |",
        "| --- | --- | --- | --- |",
      );
      for (const item of facts.network) {
        lines.push(
          `| ${item.call} | ${item.status ?? "—"} | ${item.gist} | ${item.relToIssue} |`,
        );
      }
    } else {
      lines.push("_No network errors._");
    }
    lines.push("");

    lines.push(
      "## Final page state",
      "",
      display(facts.finalPageState),
      "",
      "## Resolution",
      "",
      interpretation.resolution,
      "",
      "## Resolution evidence",
      "",
      display(interpretation.resolutionEvidence),
      "",
      "## Root cause hypothesis",
      "",
      display(interpretation.rootCauseHypothesis),
      "",
      "## Discriminators",
      "",
      `Failure family: ${normalization.failureFamily}; operation: ${display(normalization.operationKey)}; target: ${display(normalization.targetKey)}; previous passed boundary: ${display(facts.previousPassedBoundary)}; differences: ${normalization.differenceKeys.join(", ") || "none"}.`,
      "",
    );
  }

  lines.push("## Issues", "");

  for (const issue of record.issues) {
    const { facts, normalization, interpretation } = issue;
    lines.push(
      `### Issue ${issue.blockIndex}${issue.terminal ? " (terminal)" : ""}`,
      "",
      `- **Kind:** ${facts.kind}`,
      `- **Assertion:** ${display(facts.assertion)}`,
      `- **Operation:** ${display(facts.operation)}`,
      `- **Target:** ${display(facts.target)}`,
      `- **Step path:** ${facts.stepPath.length ? facts.stepPath.join(" > ") : "_unknown_"}`,
      `- **Previous passed boundary:** ${display(facts.previousPassedBoundary)}`,
      `- **Error:** ${facts.errorVerbatim}`,
      `- **Failure family:** ${normalization.failureFamily}`,
      `- **Normalized error:** ${normalization.normalizedError}`,
      `- **Operation key:** ${display(normalization.operationKey)}`,
      `- **Target key:** ${display(normalization.targetKey)}`,
      `- **Confidence:** ${interpretation.confidence}`,
      `- **Role:** ${interpretation.role}`,
      `- **Resolution:** ${interpretation.resolution}`,
      `- **Resolution evidence:** ${display(interpretation.resolutionEvidence)}`,
      `- **Expected state:** ${display(interpretation.expectedStateLabel)}`,
      `- **Observed state:** ${display(interpretation.observedStateLabel)}`,
      `- **Transition boundary:** ${display(interpretation.transitionBoundary)}`,
      `- **Caused by issue:** ${interpretation.causedByBlockIndex ?? "_none_"}`,
      "",
      "**Expected:**",
      renderList(facts.expected),
      "",
      "**Received:**",
      renderList(facts.received),
      "",
      "**Difference keys:**",
      renderList(normalization.differenceKeys),
      "",
      "**Explanation:**",
      interpretation.explanation,
      "",
      "**Root cause hypothesis:**",
      display(interpretation.rootCauseHypothesis),
      "",
      "**Ambiguities:**",
      renderList(interpretation.ambiguities),
      "",
    );
    lines.push(
      "**Source references:**",
      renderList(facts.sourceRefs),
      "",
      "**Source quotes:**",
      renderList(facts.blockQuotes),
      "",
    );
  }

  return lines.join("\n");
};
