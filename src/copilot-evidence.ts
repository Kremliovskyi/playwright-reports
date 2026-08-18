export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_FILENAME = "evidence.json";
export const AI_ANALYSIS_FILENAME = "ai-analysis.md";

export type EvidenceConfidence = "high" | "medium" | "low";

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
  transientVsFinalContradiction: string | null;
  blockQuotes: string[];
}

export interface FailureEvidenceNormalization {
  failureFamily: string;
  operationKey: string | null;
  targetKey: string | null;
  normalizedError: string;
  differenceKeys: string[];
  volatileValuesRemoved: string[];
}

export interface FailureEvidenceInterpretation {
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

const isIssue = (value: unknown): value is FailureEvidenceIssue => {
  if (typeof value !== "object" || value === null) return false;
  const issue = value as Record<string, unknown>;
  if (
    !Number.isInteger(issue.blockIndex) ||
    typeof issue.terminal !== "boolean" ||
    typeof issue.facts !== "object" ||
    issue.facts === null ||
    typeof issue.normalization !== "object" ||
    issue.normalization === null ||
    typeof issue.interpretation !== "object" ||
    issue.interpretation === null
  ) {
    return false;
  }

  const facts = issue.facts as Record<string, unknown>;
  const normalization = issue.normalization as Record<string, unknown>;
  const interpretation = issue.interpretation as Record<string, unknown>;
  return (
    isString(facts.kind) &&
    isNullableString(facts.assertion) &&
    isNullableString(facts.operation) &&
    isNullableString(facts.target) &&
    isStringArray(facts.stepPath) &&
    isNullableString(facts.previousPassedBoundary) &&
    isString(facts.errorVerbatim) &&
    isStringArray(facts.expected) &&
    isStringArray(facts.received) &&
    Array.isArray(facts.network) &&
    facts.network.every(isNetworkItem) &&
    isNullableString(facts.finalPageState) &&
    isNullableString(facts.transientVsFinalContradiction) &&
    isStringArray(facts.blockQuotes) &&
    isString(normalization.failureFamily) &&
    isNullableString(normalization.operationKey) &&
    isNullableString(normalization.targetKey) &&
    isString(normalization.normalizedError) &&
    isStringArray(normalization.differenceKeys) &&
    isStringArray(normalization.volatileValuesRemoved) &&
    isString(interpretation.explanation) &&
    isNullableString(interpretation.rootCauseHypothesis) &&
    (interpretation.confidence === "high" ||
      interpretation.confidence === "medium" ||
      interpretation.confidence === "low") &&
    isStringArray(interpretation.ambiguities)
  );
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
  if (
    response.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    !Array.isArray(response.issues) ||
    !response.issues.every(isIssue)
  ) {
    throw new Error("Evidence response does not match schema version 1");
  }
  if (response.issues.length !== errorBlocks.length) {
    throw new Error(
      `Evidence response has ${response.issues.length} issues for ${errorBlocks.length} error.md blocks`,
    );
  }

  response.issues.forEach((issue, index) => {
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
      if (
        issue.facts.finalPageState !== null ||
        issue.facts.transientVsFinalContradiction !== null
      ) {
        throw new Error(
          `Non-terminal evidence issue ${expectedBlockIndex} contains terminal page state`,
        );
      }
    }
    if (!issue.facts.blockQuotes.length)
      throw new Error(
        `Evidence issue ${expectedBlockIndex} has no source quote`,
      );
    for (const quote of issue.facts.blockQuotes) {
      if (!quote.trim() || !errorBlocks[index].includes(quote)) {
        throw new Error(
          `Evidence issue ${expectedBlockIndex} contains a quote not found in its error.md block`,
        );
      }
    }
  });

  return response.issues;
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
      "## Transient vs final check",
      "",
      display(facts.transientVsFinalContradiction),
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
    lines.push("**Source quotes:**", renderList(facts.blockQuotes), "");
  }

  return lines.join("\n");
};
