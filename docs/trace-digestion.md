# Selective Trace Digestion

[Back to documentation](index.md) | [Previous: Failure Analysis](failure-analysis.md) | [Next: Aria Snapshot Fixer](aria-snapshots.md)

Selective digestion parses one test trace instead of processing every test in a large report. The output is structured for targeted investigation and efficient use by AI agents.

## Digest a test trace

1. Open a report's overflow menu and click **Digest**.
2. Search the test list by title when needed. Each row shows the project, file location, outcome, and whether a trace is available.
3. Click **Digest** on a test with a trace.
4. On completion, copy or open the generated path, or click **View digest.json**.

The dashboard runs the installed `@andrii_kremlovskyi/playwright-traces-reader` `digest` command and writes the result into a run folder under the Current Reports Directory's `tmp` directory.

The generated data includes a chronological step tree, console information, and network NDJSON that can support debugging or downstream work such as generating API assertions or a `k6` load test.

## Manage saved digests

Every successful digest is stored against the report's stable identity and appears under **Digests** in the report's **Info** dialog. From there you can:

- Copy the digest directory path.
- Open `digest.json`.
- Delete that digest and its folder.

Digest records follow the report across renames. Deleting or archiving the report removes its ephemeral digest folders and database records. The normal directory scan also prunes orphaned digest records.

For all failed attempts in a report, use [Failure Analysis](failure-analysis.md).
