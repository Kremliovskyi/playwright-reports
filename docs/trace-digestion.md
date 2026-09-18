# Selective Trace Digestion

[Back to documentation](index.md) | [Previous: Failure Analysis](failure-analysis.md) | [Next: Aria Snapshot Fixer](aria-snapshots.md)

Selective digestion parses one test trace instead of processing every test in a large report. The output is structured for targeted investigation and efficient use by AI agents.

## Digest a test trace

1. Open a report's overflow menu and click **Digest**.
2. Search the test list by title when needed. Each row shows the project, file location, outcome, and whether a trace is available.
3. Click **Digest** on a test with a trace.
4. On completion, copy or open the generated path, or click **View digest.json**.

The dashboard runs the installed `@andrii_kremlovskyi/playwright-traces-reader` `digest` command and publishes completed results into one shared directory per report:

```text
<currentPath>/tmp/digests-<reportUuid>/<traceKey>/digest.json
```

The report UUID stays stable across renames. Trace keys distinguish different trace artifacts even when tests have identical titles or different projects/retries. Digesting the same trace again replaces its folder and saved record rather than creating another copy. If generation fails, its previous digest remains available. Different traces can be digested concurrently; a second request for the same active trace is rejected.

The trace reader's standalone CLI layout is unchanged. The dashboard generates into temporary staging, then publishes the complete folder and updates the returned paths. DOM, screenshots, and network files keep their relative links.

The generated data includes a chronological step tree, console information, and network NDJSON that can support debugging or downstream work such as generating API assertions or a `k6` load test.

## Manage saved digests

Every successful digest is stored against the report's stable identity and appears under **Digests** in the report's **Info** dialog. From there you can:

- Copy the digest directory path.
- Open `digest.json`.
- Delete that digest and its folder.

Digest records follow the report across renames. Deleting or archiving the report removes its ephemeral digest folders and database records. The normal directory scan also prunes orphaned digest records.

Deleting one digest removes only that trace's folder, not the shared root's other digests. Reanalyzing failures does not remove manual digests.

Existing digest folders are consolidated without deleting their contents when the next digest is requested for that report. If several old copies match the requested trace, confirmation lists the exact folders that will be replaced. Uncertain or missing legacy data produces a review error instead of guessed deletion. Old copied paths may change after consolidation; use the current paths in **Info**. Analysis outputs and saved vault notes are unaffected.

These are dashboard-managed artifacts, not disposable agent scratch directories. Do not delete the shared report root after inspecting one digest; use the per-digest delete action instead.

For all failed attempts in a report, use [Failure Analysis](failure-analysis.md).
