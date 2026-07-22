# Failure Analysis

[Back to documentation](index.md) | [Previous: Managing Reports](reports.md) | [Next: Trace Digestion](trace-digestion.md)

Failure analysis turns the failed attempts in a current report into compact, agent-ready folders, adds an AI-generated understanding record for each analyzable failure, and groups those records into run-level problems.

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
|   |-- ai-analysis.md
|   |-- error.md
|   |-- failure.json
|   |-- screenshots/
|   |-- console-errors.json
|   `-- network-errors.json
`-- <sanitized-test-title>__retry1/
	|-- ai-analysis.md
	|-- error.md
	|-- failure.json
	`-- screenshots/
```

`index.json` is the run manifest. It lists the failed attempts and maps each entry to its output folder. Retry folders are independent records because different attempts of the same test can fail at different steps.

The console and network error files are created only when the trace contains that type of evidence. Before Hooks and skipped entries can appear in the manifest, but they are not treated as analyzable test failures and do not receive an AI analysis record.

## What `ai-analysis.md` contains

After trace extraction, the dashboard uses the selected Copilot model to read the evidence for each analyzable failure and writes `ai-analysis.md` beside `error.md`. This file is a compact interpretation intended for quick review and downstream analysis. It includes:

- The model that generated the record.
- The ordered named `test.step` path and the deepest failing Playwright operation inside it.
- The terminal error in verbatim and normalized forms.
- A list of all detected issues, including failed soft assertions that occurred before the terminal failure.
- Relevant failed network calls and how they relate to the failing step.
- The final page state observed at the end of the attempt.
- A check for contradictions between an earlier transient state and the final page state, which helps distinguish slow completion from a flow that remained stuck.
- A root-cause hypothesis based on the available evidence.
- Discriminators that identify where the flow broke and distinguish the failure from similar-looking problems.

`ai-analysis.md` is interpreted evidence, while `error.md` remains the ground-truth assertion output, final accessibility snapshot, and source code frame. `failure.json`, screenshots, and conditional console or network files provide deeper raw evidence when needed.

If Copilot cannot produce a valid record for one folder, the dashboard still writes an `ai-analysis.md` containing the model error and directs the reader to investigate the raw files. One failed AI record does not stop analysis of the other failure folders.

## Grouped problem analysis

After every per-attempt record finishes, the dashboard makes an initial Copilot grouping request using the configured big model. The request embeds only:

- The manifest metadata needed for retries, outcomes, and test identity.
- The distilled fields from each valid per-attempt `ai-analysis.md` record.

It never sends `error.md`, `failure.json`, screenshots, console/network JSON, previous analyses, vault files, knowledge-base files, or ADO/defect information. The grouping session has no tools enabled.

Grouping prioritizes each record's discriminators and precise break point, followed by its failing step/path, normalized error and spec family, network correlation, and final page state. Every distinct issue in the records, including earlier soft assertions, receives a deterministic compact ID such as `I1` or `I2` and must be assigned exactly once. The model returns only those IDs. After validation, the dashboard maps them back to the owning folder and issue position before writing `grouped-analysis.md`, then derives retries, outcomes, test metadata, failure folders, and reconciliation counts from the manifest.

If the initial response is structurally usable but has missing, unknown, or duplicate IDs, the dashboard sends one focused repair turn in the same session. It supplies the previous complete response, the exact allowed ID set, reference diagnostics, and evidence for affected valid issues. The corrected response must assign every allowed ID exactly once and is fully revalidated. A failed repair does not discard the initial result: the dashboard removes unknown IDs and later duplicate placements, drops problems left empty, and retains unassigned valid issues under `Unclassified - invalid grouping references`.

`grouped-analysis.md` contains a summary table, one full section per problem, exact failure-folder pointers, and a failed-attempt reconciliation check. It intentionally contains no previous-run comparison, ADO defects, defect states, products, knowledge-base enrichment, tracked issues, or action-item history. Those remain follow-up work outside the dashboard.

When a per-trace AI record is missing or invalid, its attempt is retained in an Unclassified problem without reading raw evidence. If the final grouping request or its validation fails, the digest and all completed `ai-analysis.md` files remain available; the completion dialog reports a grouping warning and does not link an invalid grouped report.

Depending on the available trace data, each failure folder can contain:

- `failure.json`
- Failure screenshots
- Network and console errors
- `error.md`
- `ai-analysis.md`

## Manage analysis runs

Every successful failure-analysis run is stored against the report's stable identity and appears under **Analysis runs** in the report's **Info** dialog. Each run can have two independently managed artifacts:

- **Output directory:** The ephemeral `<currentPath>/tmp/run-<timestamp>/` directory containing `index.json`, `grouped-analysis.md`, per-attempt folders, `ai-analysis.md`, and the raw evidence. From the Info dialog, you can copy its path, open `index.json` or the grouped analysis, or delete the entire output directory.
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
