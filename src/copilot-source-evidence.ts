import type {
  FailureEvidenceAriaDiff,
  FailureEvidenceIssue,
  FailureEvidenceSourceLine,
} from "./copilot-evidence";

export interface DeterministicIssueSource {
  blockIndex: number;
  sourceText: string;
  sourceLines: FailureEvidenceSourceLine[];
  errorLine: string;
  errorLineRef: string;
  kind: string;
  assertion: string | null;
  operation: string | null;
  target: string | null;
  ariaDiff: FailureEvidenceAriaDiff | null;
  expectedStateLabel: string | null;
  observedStateLabel: string | null;
  resolutionEvidenceCandidates: string[];
}

export interface DeterministicAttemptSource {
  issues: DeterministicIssueSource[];
  finalPageState: string | null;
  finalPagePrimaryLabel: string | null;
  boundaryCandidates: string[];
  sourceText: string;
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];

interface DeterministicStepSource {
  callId: string;
  title: string;
  method: string;
  startTime: number;
  endTime: number | null;
  errorMessage: string | null;
  depth: number;
}

const parseAttemptSteps = (
  failureJsonText?: string,
): DeterministicStepSource[] => {
  if (!failureJsonText) return [];
  try {
    const failure = JSON.parse(failureJsonText) as Record<string, unknown>;
    const steps: DeterministicStepSource[] = [];
    const visit = (value: unknown, depth: number): void => {
      if (typeof value !== "object" || value === null) return;
      const step = value as Record<string, unknown>;
      const error =
        typeof step.error === "object" && step.error !== null
          ? (step.error as Record<string, unknown>)
          : null;
      if (
        typeof step.callId === "string" &&
        typeof step.title === "string" &&
        typeof step.method === "string" &&
        typeof step.startTime === "number"
      ) {
        steps.push({
          callId: step.callId,
          title: step.title,
          method: step.method,
          startTime: step.startTime,
          endTime: typeof step.endTime === "number" ? step.endTime : null,
          errorMessage:
            error && typeof error.message === "string" ? error.message : null,
          depth,
        });
      }
      if (Array.isArray(step.children))
        step.children.forEach((child) => visit(child, depth + 1));
    };
    if (Array.isArray(failure.topLevelSteps))
      failure.topLevelSteps.forEach((step) => visit(step, 0));
    return steps;
  } catch {
    return [];
  }
};

const comparableEvidenceText = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, " ").trim();

const evidenceLines = (value: string): string[] =>
  unique(
    value
      .split(/\r?\n/)
      .map(comparableEvidenceText)
      .filter((line) => line.length >= 4),
  );

const stepIssueMatchScore = (
  issue: Omit<DeterministicIssueSource, "resolutionEvidenceCandidates">,
  step: DeterministicStepSource,
): number => {
  if (!step.errorMessage) return 0;
  const stepLines = new Set(evidenceLines(step.errorMessage));
  return evidenceLines(issue.sourceText).reduce(
    (score, line) => score + (stepLines.has(line) ? line.length : 0),
    0,
  );
};

const laterPassedStepCandidates = (
  issue: Omit<DeterministicIssueSource, "resolutionEvidenceCandidates">,
  steps: DeterministicStepSource[],
): string[] => {
  const anchor = steps
    .map((step) => ({ step, score: stepIssueMatchScore(issue, step) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.step.depth !== left.step.depth)
        return right.step.depth - left.step.depth;
      return right.step.startTime - left.step.startTime;
    })[0]?.step;
  if (!anchor) return [];
  const anchorTime = anchor.endTime ?? anchor.startTime;
  return unique(
    steps
      .filter(
        (step) =>
          step.errorMessage === null &&
          step.endTime !== null &&
          step.startTime >= anchorTime,
      )
      .sort((left, right) => left.startTime - right.startTime)
      .map(
        (step) => `passed-step:${step.callId}: ${step.title} (${step.method})`,
      ),
  ).slice(0, 20);
};

const sourceLine = (
  blockIndex: number,
  lineIndex: number,
  text: string,
): FailureEvidenceSourceLine => ({
  id: `B${blockIndex}-L${lineIndex + 1}`,
  text,
});

const ariaSemanticText = (line: string): string =>
  line
    .slice(2)
    .trim()
    .replace(/^[-+]\s+/, "")
    .trim();

const isAriaDiffLine = (line: string, prefix: "+" | "-"): boolean => {
  if (!line.startsWith(`${prefix} `)) return false;
  const text = line.slice(2).trim();
  if (/^(?:Expected|Received)\s+[+-]/.test(text)) return false;
  return text.length > 0;
};

const quotedRoleLabel = (text: string, role: string): string | null =>
  text.match(new RegExp(`${role}\\s+"([^"]+)"`, "i"))?.[1] || null;

const parseAriaDiff = (
  lines: FailureEvidenceSourceLine[],
): FailureEvidenceAriaDiff | null => {
  const removed = lines.filter((line) => isAriaDiffLine(line.text, "-"));
  const added = lines.filter((line) => isAriaDiffLine(line.text, "+"));
  return removed.length || added.length ? { removed, added } : null;
};

const firstErrorLine = (
  lines: FailureEvidenceSourceLine[],
): FailureEvidenceSourceLine =>
  lines.find((line) =>
    /^(?:Error|TimeoutError|AssertionError):/.test(line.text.trim()),
  ) ||
  lines.find((line) => line.text.trim()) ||
  lines[0];

const parseAssertion = (block: string): string | null =>
  block.match(/\.(to[A-Z][A-Za-z]+)\(/)?.[1] ||
  block.match(/\b(toMatchAriaSnapshot|toEqual|toBe|toBeVisible)\b/)?.[1] ||
  null;

const parseOperation = (
  block: string,
  assertion: string | null,
): string | null =>
  block.match(/^(?:Error|TimeoutError):\s+([A-Za-z][\w.]+):/m)?.[1] ||
  assertion ||
  null;

const parseTarget = (block: string): string | null =>
  block.match(/^Locator:\s*(.+)$/m)?.[1]?.trim() ||
  block.match(/^\s*- waiting for (.+)$/m)?.[1]?.trim() ||
  null;

const deriveKind = (errorLine: string, assertion: string | null): string => {
  if (/timeout/i.test(errorLine)) return "timeout";
  if (assertion === "toMatchAriaSnapshot") return "soft assertion";
  if (/expect\(/i.test(errorLine)) return "assertion";
  return "failure";
};

const changedHeading = (
  diff: FailureEvidenceAriaDiff | null,
  side: "removed" | "added",
): string | null => {
  if (!diff) return null;
  for (const line of diff[side]) {
    const label = quotedRoleLabel(ariaSemanticText(line.text), "heading");
    if (label) return label;
  }
  return null;
};

const markdownSection = (markdown: string, heading: string): string | null => {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`^# ${escaped}\\s*$`, "m"));
  if (match?.index === undefined) return null;
  const remainder = markdown.slice(match.index + match[0].length);
  const nextHeading = remainder.search(/^#\s+/m);
  return (
    nextHeading === -1 ? remainder : remainder.slice(0, nextHeading)
  ).trim();
};

const fencedContent = (section: string | null): string =>
  section?.match(/^```[^\n]*\n([\s\S]*?)^```\s*$/m)?.[1]?.trim() || "";

const parseFinalPage = (
  errorMd: string,
): { summary: string | null; primaryLabel: string | null } => {
  const yaml = fencedContent(markdownSection(errorMd, "Page snapshot"));
  if (!yaml) return { summary: null, primaryLabel: null };
  const roleLabels: Array<{ role: string; label: string }> = [];
  for (const line of yaml.split(/\r?\n/)) {
    const match = line.match(/\b(heading|alert|button|link)\s+"([^"]+)"/i);
    if (match)
      roleLabels.push({ role: match[1].toLowerCase(), label: match[2] });
  }
  const leafLabels = [...yaml.matchAll(/:\s+([^\[\]{][^\n]*)$/gm)]
    .map((match) => match[1].trim())
    .filter((value) => value.length > 1 && value.length <= 180);
  const labels = unique([
    ...roleLabels.map(({ role, label }) => `${role}: ${label}`),
    ...leafLabels,
  ]).slice(0, 12);
  const primaryLabel =
    roleLabels.find(({ role }) => role === "heading")?.label ||
    roleLabels.find(({ role }) => role === "alert")?.label ||
    leafLabels[0] ||
    null;
  return {
    summary: labels.length ? labels.join("; ") : yaml.slice(0, 1000),
    primaryLabel,
  };
};

const parseBoundaryCandidates = (failureJsonText?: string): string[] => {
  if (!failureJsonText) return [];
  try {
    const failure = JSON.parse(failureJsonText) as Record<string, unknown>;
    const candidates: string[] = [];
    const visit = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      const step = value as Record<string, unknown>;
      if (typeof step.title === "string" && step.title.trim())
        candidates.push(step.title.trim());
      if (Array.isArray(step.children)) step.children.forEach(visit);
    };
    if (typeof failure.title === "string" && failure.title.trim())
      candidates.push(failure.title.trim());
    if (Array.isArray(failure.topLevelSteps))
      failure.topLevelSteps.forEach(visit);
    return unique(candidates);
  } catch {
    return [];
  }
};

export const buildDeterministicAttemptSource = (
  errorMd: string,
  errorBlocks: string[],
  failureJsonText?: string,
): DeterministicAttemptSource => {
  const finalPage = parseFinalPage(errorMd);
  const parsedIssues = errorBlocks.map((block, index) => {
    const blockIndex = index + 1;
    const sourceLines = block
      .split(/\r?\n/)
      .map((text, lineIndex) => sourceLine(blockIndex, lineIndex, text));
    const error = firstErrorLine(sourceLines);
    const assertion = parseAssertion(block);
    const ariaDiff = parseAriaDiff(sourceLines);
    return {
      blockIndex,
      sourceText: block,
      sourceLines,
      errorLine: error.text.trim(),
      errorLineRef: error.id,
      kind: deriveKind(error.text, assertion),
      assertion,
      operation: parseOperation(block, assertion),
      target: parseTarget(block),
      ariaDiff,
      expectedStateLabel: changedHeading(ariaDiff, "removed"),
      observedStateLabel:
        changedHeading(ariaDiff, "added") ||
        (blockIndex === errorBlocks.length ? finalPage.primaryLabel : null),
    };
  });
  const steps = parseAttemptSteps(failureJsonText);
  const issues = parsedIssues.map((issue, index) => ({
    ...issue,
    resolutionEvidenceCandidates: unique([
      ...(index === parsedIssues.length - 1 && finalPage.summary
        ? [`final-page: ${finalPage.summary}`]
        : []),
      ...laterPassedStepCandidates(issue, steps),
    ]),
  }));
  return {
    issues,
    finalPageState: finalPage.summary,
    finalPagePrimaryLabel: finalPage.primaryLabel,
    boundaryCandidates: parseBoundaryCandidates(failureJsonText),
    sourceText: errorMd,
  };
};

export const canonicalKey = (value: string | null): string | null => {
  if (!value) return null;
  const key = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return key || null;
};

const normalizeChangedLine = (
  line: FailureEvidenceSourceLine,
): string | null => {
  const text = ariaSemanticText(line.text)
    .replace(/^\/?children:\s*deep-equal$/i, "")
    .replace(/^(?:paragraph|generic):?$/i, "")
    .trim();
  return text || null;
};

const changedValues = (
  diff: FailureEvidenceAriaDiff | null,
  side: "removed" | "added",
): string[] =>
  diff
    ? unique(
        diff[side]
          .map(normalizeChangedLine)
          .filter((value): value is string => !!value),
      )
    : [];

const canonicalFailureFamily = (source: DeterministicIssueSource): string => {
  if (source.ariaDiff || source.assertion === "toMatchAriaSnapshot")
    return "aria-snapshot-mismatch";
  if (
    /timeout/i.test(source.errorLine) &&
    source.operation?.startsWith("locator.")
  )
    return "locator-timeout";
  if (
    /expected\s+(?:http\s+)?status|received\s+(?:http\s+)?\d{3}/i.test(
      source.sourceText,
    )
  )
    return "http-status-mismatch";
  if (
    /unexpected\s+(?:field|property)|toEqual|toMatchObject/i.test(
      source.sourceText,
    )
  )
    return "response-contract-mismatch";
  if (/timeout/i.test(source.errorLine)) return "timeout";
  if (source.assertion) return "assertion-mismatch";
  return "failure";
};

const normalizedError = (errorLine: string): string =>
  errorLine
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/gi, "<duration>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/\s+/g, " ")
    .trim();

const deterministicDifferenceKeys = (
  source: DeterministicIssueSource,
  expected: string[],
  received: string[],
): string[] => {
  const keys = [
    ...changedValues(source.ariaDiff, "removed").map(
      (value) => `missing:${canonicalKey(value)}`,
    ),
    ...changedValues(source.ariaDiff, "added").map(
      (value) => `unexpected:${canonicalKey(value)}`,
    ),
  ];
  if (!keys.length) {
    keys.push(
      ...expected.map((value) => `expected:${canonicalKey(value)}`),
      ...received.map((value) => `received:${canonicalKey(value)}`),
    );
  }
  return unique(keys.filter((key) => !key.endsWith(":null")));
};

const labelAppearsInIssueSource = (
  label: string,
  issue: FailureEvidenceIssue,
  source: DeterministicAttemptSource,
): boolean => {
  const issueSource = source.issues[issue.blockIndex - 1];
  if (issueSource.sourceText.toLowerCase().includes(label.toLowerCase()))
    return true;
  if (!issue.terminal) return false;
  return [source.finalPagePrimaryLabel, source.finalPageState].some((value) =>
    value?.toLowerCase().includes(label.toLowerCase()),
  );
};

const validateCausalInterpretation = (
  issue: FailureEvidenceIssue,
  source: DeterministicAttemptSource,
): void => {
  const { interpretation } = issue;
  for (const [name, label] of [
    ["expectedStateLabel", interpretation.expectedStateLabel],
    ["observedStateLabel", interpretation.observedStateLabel],
  ] as const) {
    if (label && !labelAppearsInIssueSource(label, issue, source))
      throw new Error(
        `Evidence issue ${issue.blockIndex} ${name} is not present in its issue evidence`,
      );
  }
  if (
    interpretation.transitionBoundary !== null &&
    !source.boundaryCandidates.includes(interpretation.transitionBoundary)
  ) {
    throw new Error(
      `Evidence issue ${issue.blockIndex} transitionBoundary is not an application-provided boundary candidate`,
    );
  }
  if (
    interpretation.causedByBlockIndex !== null &&
    (!Number.isInteger(interpretation.causedByBlockIndex) ||
      interpretation.causedByBlockIndex < 1 ||
      interpretation.causedByBlockIndex >= issue.blockIndex)
  ) {
    throw new Error(
      `Evidence issue ${issue.blockIndex} causedByBlockIndex must reference an earlier block`,
    );
  }
  if (
    interpretation.role === "downstream" &&
    interpretation.causedByBlockIndex === null
  ) {
    throw new Error(
      `Evidence issue ${issue.blockIndex} downstream role requires causedByBlockIndex`,
    );
  }
  if (
    interpretation.role !== "downstream" &&
    interpretation.causedByBlockIndex !== null
  ) {
    throw new Error(
      `Evidence issue ${issue.blockIndex} only a downstream role may reference causedByBlockIndex`,
    );
  }
  if (interpretation.resolution !== "unknown") {
    if (
      !interpretation.resolutionEvidence ||
      !source.issues[
        issue.blockIndex - 1
      ].resolutionEvidenceCandidates.includes(interpretation.resolutionEvidence)
    )
      throw new Error(
        `Evidence issue ${issue.blockIndex} ${interpretation.resolution} requires an exact application-provided resolution evidence candidate`,
      );
  }
  if (
    interpretation.resolution === "unknown" &&
    interpretation.resolutionEvidence !== null
  )
    throw new Error(
      `Evidence issue ${issue.blockIndex} unknown resolution must not include resolutionEvidence`,
    );
};

export const applyDeterministicEvidence = (
  modelIssues: FailureEvidenceIssue[],
  source: DeterministicAttemptSource,
): FailureEvidenceIssue[] => {
  const issues = modelIssues.map((issue, index) => {
    const issueSource = source.issues[index];
    const terminal = index === modelIssues.length - 1;
    const ariaExpected = changedValues(issueSource.ariaDiff, "removed");
    const ariaReceived = changedValues(issueSource.ariaDiff, "added");
    const expected = issueSource.ariaDiff ? ariaExpected : issue.facts.expected;
    const received = issueSource.ariaDiff ? ariaReceived : issue.facts.received;
    const expectedStateLabel =
      issue.interpretation.expectedStateLabel || issueSource.expectedStateLabel;
    const observedStateLabel =
      issue.interpretation.observedStateLabel || issueSource.observedStateLabel;
    const sourceRefs = unique([
      issueSource.errorLineRef,
      ...(issueSource.ariaDiff?.removed || []).map((line) => line.id),
      ...(issueSource.ariaDiff?.added || []).map((line) => line.id),
    ]);
    const blockQuotes = sourceRefs
      .map((ref) =>
        issueSource.sourceLines.find((line) => line.id === ref)?.text.trim(),
      )
      .filter((value): value is string => !!value);
    const finalized: FailureEvidenceIssue = {
      ...issue,
      blockIndex: index + 1,
      terminal,
      facts: {
        ...issue.facts,
        kind: issueSource.kind,
        assertion: issueSource.assertion,
        operation: issueSource.operation,
        target: issueSource.target,
        errorVerbatim: issueSource.errorLine,
        expected,
        received,
        finalPageState: terminal ? source.finalPageState : null,
        blockQuotes,
        sourceRefs,
        ariaDiff: issueSource.ariaDiff,
      },
      normalization: {
        failureFamily: canonicalFailureFamily(issueSource),
        operationKey: canonicalKey(issueSource.operation),
        targetKey: canonicalKey(issueSource.target),
        normalizedError: normalizedError(issueSource.errorLine),
        differenceKeys: deterministicDifferenceKeys(
          issueSource,
          expected,
          received,
        ),
        volatileValuesRemoved: /\b\d+(?:\.\d+)?\s*ms\b/i.test(
          issueSource.errorLine,
        )
          ? ["duration"]
          : [],
        expectedStateKey: canonicalKey(expectedStateLabel),
        observedStateKey: canonicalKey(observedStateLabel),
        transitionBoundaryKey: canonicalKey(
          issue.interpretation.transitionBoundary,
        ),
      },
      interpretation: {
        ...issue.interpretation,
        expectedStateLabel,
        observedStateLabel,
      },
    };
    validateCausalInterpretation(finalized, source);
    return finalized;
  });
  return issues;
};

export const buildDeterministicFallbackIssues = (
  source: DeterministicAttemptSource,
): FailureEvidenceIssue[] => {
  const provisional = source.issues.map(
    (issueSource, index): FailureEvidenceIssue => ({
      blockIndex: index + 1,
      terminal: index === source.issues.length - 1,
      facts: {
        kind: issueSource.kind,
        assertion: issueSource.assertion,
        operation: issueSource.operation,
        target: issueSource.target,
        stepPath: [],
        previousPassedBoundary: null,
        errorVerbatim: issueSource.errorLine,
        expected: [],
        received: [],
        network: [],
        finalPageState: null,
        blockQuotes: [],
        sourceRefs: [],
        ariaDiff: null,
      },
      normalization: {
        failureFamily: "failure",
        operationKey: null,
        targetKey: null,
        normalizedError: issueSource.errorLine,
        differenceKeys: [],
        volatileValuesRemoved: [],
        expectedStateKey: null,
        observedStateKey: null,
        transitionBoundaryKey: null,
      },
      interpretation: {
        expectedStateLabel: issueSource.expectedStateLabel,
        observedStateLabel: issueSource.observedStateLabel,
        role: "independent",
        causedByBlockIndex: null,
        resolution: "unknown",
        resolutionEvidence: null,
        transitionBoundary: null,
        explanation:
          "Deterministic source evidence retained after model extraction failed.",
        rootCauseHypothesis: null,
        confidence: "low",
        ambiguities: ["Small-model interpretation was unavailable."],
      },
    }),
  );
  return applyDeterministicEvidence(provisional, source);
};

export const sourcePromptProjection = (
  source: DeterministicAttemptSource,
): unknown => ({
  issues: source.issues.map((issue) => ({
    blockIndex: issue.blockIndex,
    errorLine: issue.errorLine,
    kind: issue.kind,
    assertion: issue.assertion,
    operation: issue.operation,
    target: issue.target,
    ariaDiff: issue.ariaDiff,
    expectedStateLabelCandidate: issue.expectedStateLabel,
    observedStateLabelCandidate: issue.observedStateLabel,
    resolutionEvidenceCandidates: issue.resolutionEvidenceCandidates,
  })),
  finalPageState: source.finalPageState,
  finalPagePrimaryLabel: source.finalPagePrimaryLabel,
  boundaryCandidates: source.boundaryCandidates,
});
