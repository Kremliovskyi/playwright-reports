# Failure Analysis

[Back to documentation](index.md) | [Previous: Managing Reports](reports.md) | [Next: Trace Digestion](trace-digestion.md)

Failure analysis turns the failed attempts in a current report into compact, agent-ready folders, extracts canonical issue evidence for each analyzable failure, and groups those records into run-level problems.

## Before you begin

Use the **Copilot** tab in [Preferences](configuration.md#copilot) to configure an optional GitHub token and select the small per-trace model and big grouping model. If no token is provided, the dashboard uses the host's Copilot CLI or GitHub CLI authentication. The header chip checks access only.

## Analyze a report

1. Open the overflow menu on a current report.
2. Click **Analyze Failures**.
3. Keep the dashboard open while the row progress bar is active. Large reports and antivirus scanning can make this operation take time.
4. When analysis finishes, use **Copy Relative Path**, **View index.json**, or **View grouped-analysis.md** in the completion dialog.

The dashboard runs the installed [`@andrii_kremlovskyi/playwright-traces-reader`](https://www.npmjs.com/package/@andrii_kremlovskyi/playwright-traces-reader) `failures` command and writes output below the Current Reports Directory:

```text
<currentPath>/tmp/run-<timestamp>/
```

## Concurrent requests and trace extraction

Only one failure-analysis request may run for a report at a time. Repeated clicks in the same dashboard page are ignored while that report is active. If another browser tab or client starts the same report concurrently, the server returns `FAILURE_ANALYSIS_IN_PROGRESS`; the row briefly shows **Analysis already running** instead of starting a second CLI process. Different reports can still be analyzed independently, and the bounded three-way Copilot processing inside one completed digest is unaffected.

The trace reader does not extract ZIPs into the report. It uses a persistent, content-addressed cache under the operating system's temporary directory:

```text
<os.tmpdir>/playwright-traces-reader/trace-cache/
```

Concurrent readers publish completed cache entries atomically. The reader accepts a verified competing entry and retries transient Windows `EPERM` rename failures, including brief antivirus or indexing locks. The source report remains unchanged. Before analysis starts, completed entries unused for 24 hours and staging entries older than 1 hour are pruned, unless another live reader lease exists. `PWTR_CACHE_MAX_AGE_HOURS` and `PWTR_CACHE_STAGING_MAX_AGE_HOURS` override those defaults; `0` disables the corresponding age policy. There is no size cap. When no analysis or trace-reader library consumer is running, the entire cache can be deleted and will be rebuilt on demand. See [Troubleshooting](troubleshooting.md#failure-analysis-fails-with-a-trace-cache-eperm-error) for recovery steps.

## Analysis directory layout

Every failed attempt, including each retry, receives a separate folder. A generated run has this general layout:

```text
run-<timestamp>/
|-- index.json
|-- grouped-analysis.md
|-- <sanitized-test-title>__retry0/
|   |-- evidence.json
|   |-- ai-analysis.md
|   |-- error.md
|   |-- failure.json
|   |-- screenshots/
|   |-- console-errors.json
|   `-- network-errors.json
`-- <sanitized-test-title>__retry1/
	|-- evidence.json
	|-- ai-analysis.md
	|-- error.md
	|-- failure.json
	`-- screenshots/
```

`index.json` is the run manifest. It lists the failed attempts and maps each entry to its output folder. Retry folders are independent records because different attempts of the same test can fail at different steps.

The console and network error files are created only when the trace contains that type of evidence. Before Hooks and skipped entries can appear in the manifest, but they are not treated as analyzable test failures and do not receive an AI analysis record.

## What `evidence.json` and `ai-analysis.md` contain

After trace extraction, application code parses every fenced block under `# Error details` and writes schema-v2 `evidence.json` beside `error.md`. The selected small Copilot model supplies only bounded semantic context and causal interpretation. Each issue record contains:

- Application-owned source block index, terminal marker, error, assertion, operation, target, source-line references, parsed ARIA removed/added lines, and terminal page state.
- Stable application-derived comparison fields: failure family, operation key, target key, normalized error, expected/observed state keys, transition-boundary key, and concrete difference keys.
- Model-supplied step context, relevant network correlation, expected/observed state labels, causal role, optional earlier causal block, explanation, evidence-based hypothesis, confidence, and ambiguities.
- A transition boundary selected verbatim from application-extracted test-step titles. State labels must occur in that issue's source block, except that the terminal issue may reference its final page.
- Final page state and transient-versus-final check only for the terminal issue.

The dashboard then renders `ai-analysis.md` deterministically from the same JSON; there is no second model call. Its top-level terminal summary preserves the existing Step path, Error, Network, Final page state, Transient vs final check, Root cause hypothesis, and Discriminators headings for investigation workflows, followed by the complete per-issue evidence.

If the first semantic response is not valid JSON or violates the evidence contract, the dashboard makes one focused correction request in the same small-model session. The correction includes the exact validation error and the deterministic source projection, including allowed boundary candidates. The complete corrected response is revalidated against the same strict contract.

`error.md` remains ground truth. `evidence.json` is the canonical model-to-model contract, while `ai-analysis.md` is its human-readable view. `failure.json`, screenshots, and conditional console or network files provide deeper raw evidence when needed.

If the corrected semantic response is still invalid, the dashboard retains low-confidence deterministic issues with a warning instead of dropping the attempt into an extraction-only Unclassified bucket. A folder is unavailable only when its source files cannot be read or processed. One failed record does not stop analysis of the other failure folders.

## Grouped problem analysis

After every per-attempt record finishes, the dashboard makes an initial Copilot grouping request using the configured big model. The request embeds only:

- The manifest metadata needed for retries, outcomes, and test identity.
- The issue-local factual, normalized, interpretation, and deterministic incident-hint fields from source-backed `evidence.json` records.

The initial request never sends raw `error.md`, `failure.json`, screenshots, console/network files, previous analyses, vault files, knowledge-base files, or ADO/defect information. The grouping session has no tools enabled.

Grouping prioritizes direct causal anchors, then shared observed-state plus transition-boundary keys, then exact content-difference fingerprints. Response contracts, network correlation, and normalized errors follow. Operations, locators, targets, and step paths are symptom context and do not split issues when a stronger current-run incident signal agrees. Materially different observed states, transition boundaries, content fingerprints, or transient-versus-final outcomes remain separate. Every issue, including earlier soft assertions, receives a deterministic compact ID such as `I1` or `I2` and must be assigned exactly once.

When a plausible merge cannot be decided because critical evidence is missing, ambiguous, or conflicting, a complete provisional response may request one bounded source-evidence round. The application first verifies that the provisional response references every issue exactly once, then accepts only current-run issue IDs and the `error-block`, `final-page`, `test-source`, or `network` sections. It allows at most 10 requests, 4 issue IDs per request, 30 issue references overall, 6,000 characters per section, 48,000 characters of extracted source text overall, and 4 MiB per source file read. Every resolved file must remain inside its assigned failure folder. The selected snippets are sent in a second turn in the same session; no arbitrary file access or second evidence round is allowed. If retrieval or the final response fails, the complete provisional grouping is retained and validated.

After the final response, the dashboard maps issue IDs back to folders and block positions before writing `grouped-analysis.md`, then derives retries, outcomes, test metadata, failure folders, and reconciliation counts from the manifest.

If the initial response has missing, unknown, or duplicate IDs, or separates a downstream symptom from its declared causal anchor, the dashboard sends one focused repair turn in the same session. It supplies the previous complete response, the exact allowed ID set, contract diagnostics, and evidence for affected valid issues. The corrected response must assign every allowed ID exactly once and co-locate direct causal links. A failed repair does not discard the initial result: the dashboard removes invalid references, deterministically moves downstream symptoms to their anchor problem, drops problems left empty, and retains unassigned valid issues under `Unclassified - invalid grouping references`.

`grouped-analysis.md` contains a summary table, one full section per problem, exact failure-folder pointers, and a failed-attempt reconciliation check. It intentionally contains no previous-run comparison, ADO defects, defect states, products, knowledge-base enrichment, tracked issues, or action-item history. Those remain follow-up work outside the dashboard.

When source-backed evidence cannot be created for a folder, its attempt is retained in an Unclassified problem without reading raw evidence during grouping. If the final grouping request or its validation fails, the digest and all completed evidence files remain available; the completion dialog reports a grouping warning and does not link an invalid grouped report.

Depending on the available trace data, each failure folder can contain:

- `failure.json`
- Failure screenshots
- Network and console errors
- `error.md`
- `evidence.json`
- `ai-analysis.md`

## Manage analysis runs

Every successful failure-analysis run is stored against the report's stable identity and appears under **Analysis runs** in the report's **Info** dialog. Each run can have two independently managed artifacts:

- **Output directory:** The ephemeral `<currentPath>/tmp/run-<timestamp>/` directory containing `index.json`, `grouped-analysis.md`, per-attempt folders, `evidence.json`, `ai-analysis.md`, and the raw evidence. From the Info dialog, you can copy its path, open `index.json` or the grouped analysis, or delete the entire output directory.
- **Analysis file:** An optional, longer-lived `<runName>.md` note mapped from the configured vault. You can copy its path, open the rendered Markdown page, or delete the file independently of the output directory.

The artifacts follow this lifecycle:

- **Report rename:** The analysis runs remain attached because they are keyed by the report's stable internal identity rather than its folder name.
- **Delete output directory:** The generated `tmp/run-*` directory and all files inside it, including `grouped-analysis.md`, are removed. The run entry and any mapped vault analysis file remain available in the Info dialog.
- **Delete analysis file:** The vault Markdown file is removed. The generated output directory remains available when it still exists. If both artifacts are gone, the empty run entry is removed as well.
- **Archive report:** The ephemeral output directory and its grouped analysis are removed because they do not follow the report into the archive. An existing vault analysis file is moved to `<archivePath>/analysis/`, and its mapping remains attached to the archived report.
- **Delete report:** The output directories, mapped analysis files, and database run records associated with that report are removed.
- **Report removed or replaced outside the dashboard:** The next directory scan removes run records belonging to the missing report instance and prevents them from being attached to a new report that reuses the same folder name.

Deleting an output directory does not change the Playwright report folder itself; analysis output lives under the Current Reports Directory's separate `tmp` folder.

For one test rather than every failure in a report, use [Selective Trace Digestion](trace-digestion.md).
