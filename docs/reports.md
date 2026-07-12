# Managing Reports

[Back to documentation](index.md) | [Previous: Running Tests](running-tests.md) | [Next: Failure Analysis](failure-analysis.md)

The dashboard scans the configured current and archive directories for Playwright HTML reports. Report metadata, creation dates, and stable per-report identities are persisted in SQLite.

## Open and inspect reports

Click a report row to open the Playwright HTML report. Use the always-available **Info** action to see its cached size, analysis runs, mapped Markdown analysis files, and saved trace digests.

## Search and filter

Open **Search** in the header to filter persisted reports by metadata and creation date.

- Metadata matching is case-insensitive and requires every whitespace-delimited search term. For example, `UAT e2e` matches `UAT EU e2e`.
- Use **From** and **To** for a full or partial date range.
- Press `Enter` in a search or date field to apply the filter.
- Closing the panel keeps the current filter active, and the Search button stays highlighted.
- **Reset** clears the fields and restores the unfiltered dashboard.
- Refresh is disabled while the panel is open, but report actions remain available on filtered results.

Search is read-only. It queries the persisted report index without scanning directories, changing metadata, or mutating report files.

## Edit report metadata

Click the **Metadata** column to add labels such as `UAT NA` or `Sprint 24`. Metadata survives refreshes, report renames, and archive moves.

The dashboard captures each report directory's creation time and gives that physical report instance a stable internal `uuid`. If a deleted folder name is later reused for a new report, the changed creation time prevents old analysis runs from being attached to the new report.

## Select multiple reports

Each Current and Archived row has a checkbox. Use **Select All**, **Select None**, or Shift-click to select a visible range. The **Actions** menu appears when at least one row is selected.

- Current reports can be archived or deleted in bulk.
- Archived reports can be deleted in bulk.

## Archive reports

Click **Archive** for one report, or select current reports and choose **Actions > Archive selected**. The dashboard moves each report into the configured archive directory with a timestamped folder name that avoids collisions.

Mapped vault analysis files move into the archive's `analysis/` directory. Ephemeral analysis output and trace digest directories are removed, while the analysis-file mapping remains available from the archived report's Info dialog.

### Archive capacity

The archive holds at most 20 reports.

- When an archive operation would exceed the limit, a dialog offers to delete the oldest archived reports first.
- The cleanup removes at least five reports when possible, and always enough to fit the incoming reports.
- Canceling leaves all reports untouched.
- Selecting more than 20 reports for one archive operation is blocked.

## Delete reports

Click **Delete** on one row, or select rows and choose **Actions > Delete selected**. After confirmation, the dashboard permanently removes the report directories and associated ephemeral analysis data, then refreshes the tables.

## Extract traces

Click **Extract** on a report to unpack its Playwright trace `.zip` files into raw trace data on the host machine. Extraction is available per report; archive and delete support bulk selection.

For structured, test-specific output, use [Selective Trace Digestion](trace-digestion.md).

## View analysis notes

Set an Obsidian vault directory in [Configuration](configuration.md) to associate Markdown notes with analysis runs.

- The report's **Info** dialog links to each mapped note.
- Markdown is rendered with headings, tables, code blocks, links, and images.
- Click **Edit** to update a note in the dashboard and save it back to disk.
- Notes associated with archived reports are resolved from the archive's `analysis/` directory.
- Agents can access notes through `/api/agent/vault/list` and `/api/agent/vault/:filename`.
