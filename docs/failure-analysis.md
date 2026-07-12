# Failure Analysis

[Back to documentation](index.md) | [Previous: Managing Reports](reports.md) | [Next: Trace Digestion](trace-digestion.md)

Failure analysis turns the failed attempts in a current report into compact, agent-ready folders and adds an AI-generated understanding record for each analyzable failure.

## Before you begin

Use [Configuration](configuration.md) to authenticate Copilot and select the model that should generate analyses.

## Analyze a report

1. Open the overflow menu on a current report.
2. Click **Analyze Failures**.
3. Keep the dashboard open while the row progress bar is active. Large reports and antivirus scanning can make this operation take time.
4. When analysis finishes, use **Copy Relative Path** or **View index.json** in the completion dialog.

The dashboard runs the installed `@andrii_kremlovskyi/playwright-traces-reader` `failures` command and writes output below the Current Reports Directory:

```text
<currentPath>/tmp/run-<timestamp>/
```

Every failed attempt, including retries, receives its own folder. Depending on the available trace data, it contains:

- `failure.json`
- Failure screenshots
- Network and console errors
- `error.md`
- `ai-analysis.md`

The run root also contains an `index.json` manifest.

## Find previous analyses

Open a report's **Info** dialog to see its analysis runs and any mapped vault Markdown file. From there you can copy or open output paths and independently delete an ephemeral output directory or its analysis note.

Deleting output keeps the mapped note. Deleting the note removes that mapping. Archiving removes ephemeral output but preserves a mapped note in the archive.

For one test rather than every failure in a report, use [Selective Trace Digestion](trace-digestion.md).
