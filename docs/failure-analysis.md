# Failure Analysis

[Back to documentation](index.md) | [Previous: Managing Reports](reports.md) | [Next: Trace Digestion](trace-digestion.md)

Failure analysis turns the failed attempts in a current report into compact, agent-ready folders and adds an AI-generated understanding record for each analyzable failure.

## Before you begin

The **Copilot** tab in [Preferences](configuration.md#copilot) only configures an optional GitHub token. If no token is provided, the dashboard uses the host's Copilot CLI or GitHub CLI authentication.

Model selection is separate from Preferences. Click the **Copilot** chip in the dashboard header to check authentication and open the model picker. The selected model is used to generate the per-failure analysis records described below.

## Analyze a report

1. Open the overflow menu on a current report.
2. Click **Analyze Failures**.
3. Keep the dashboard open while the row progress bar is active. Large reports and antivirus scanning can make this operation take time.
4. When analysis finishes, use **Copy Relative Path** or **View index.json** in the completion dialog.

The dashboard runs the installed [`@andrii_kremlovskyi/playwright-traces-reader`](https://www.npmjs.com/package/@andrii_kremlovskyi/playwright-traces-reader) `failures` command and writes output below the Current Reports Directory:

```text
<currentPath>/tmp/run-<timestamp>/
```

## Analysis directory layout

Every failed attempt, including each retry, receives a separate folder. A generated run has this general layout:

```text
run-<timestamp>/
|-- index.json
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
- The ordered test-step path and deepest failing step.
- The terminal error in verbatim and normalized forms.
- A list of all detected issues, including failed soft assertions that occurred before the terminal failure.
- Relevant failed network calls and how they relate to the failing step.
- The final page state observed at the end of the attempt.
- A check for contradictions between an earlier transient state and the final page state, which helps distinguish slow completion from a flow that remained stuck.
- A root-cause hypothesis based on the available evidence.
- Discriminators that identify where the flow broke and distinguish the failure from similar-looking problems.

`ai-analysis.md` is interpreted evidence, while `error.md` remains the ground-truth assertion output, final accessibility snapshot, and source code frame. `failure.json`, screenshots, and conditional console or network files provide deeper raw evidence when needed.

If Copilot cannot produce a valid record for one folder, the dashboard still writes an `ai-analysis.md` containing the model error and directs the reader to investigate the raw files. One failed AI record does not stop analysis of the other failure folders.

Depending on the available trace data, each failure folder can contain:

- `failure.json`
- Failure screenshots
- Network and console errors
- `error.md`
- `ai-analysis.md`

## Find previous analyses

Open a report's **Info** dialog to see its analysis runs and any mapped vault Markdown file. From there you can copy or open output paths and independently delete an ephemeral output directory or its analysis note.

Deleting output keeps the mapped note. Deleting the note removes that mapping. Archiving removes ephemeral output but preserves a mapped note in the archive.

For one test rather than every failure in a report, use [Selective Trace Digestion](trace-digestion.md).
