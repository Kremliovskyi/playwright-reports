# Managing Reports

[Back to documentation](index.md) | [Previous: Running Tests](running-tests.md) | [Next: Failure Analysis](failure-analysis.md)

The dashboard scans the configured current and archive directories for Playwright HTML reports. Report metadata, creation dates, and stable per-report identities are persisted in SQLite.

## Open and inspect reports

Click a report row to open the Playwright HTML report. Use the always-available **Info** action to see its cached size, analysis runs, mapped Markdown analysis files, and saved trace digests.

## Search and filter

Open **Search** in the header to filter persisted reports by metadata and creation date.

- Metadata matching is case-insensitive and requires every whitespace-delimited search term. For example, `UAT e2e` matches `UAT EU e2e`.
- **From** and **To** initially span the oldest through newest report across both Current and Archive, independently of metadata. Bounds use the catalog creation date in UTC, not the test execution timestamp. A single report gives equal bounds; an empty catalog leaves them blank and disabled.
- Edit either date for an explicit full or partial range. Opening the panel does not apply a filter, and untouched defaults do not become a fixed date filter that would hide future reports.
- Press `Enter` in a search or date field to apply the filter.
- Closing the panel keeps the current filter active, and the Search button stays highlighted.
- **Reset** clears metadata and the applied filter, restores the unfiltered dashboard, and repopulates the full date range. Explicitly applied dates survive closing and reopening Search.
- Refresh is disabled while the panel is open, but report actions remain available on filtered results.

Search is read-only. It queries the persisted report index without scanning directories, changing metadata, or mutating report files.

## Test Trends

Open **Trends** beside Search in the dashboard header. Refresh and Preferences are compact icon controls; on narrow screens they are in **More actions**. Trends does not change the dashboard's active Search filter.

Enter metadata such as `DEV NA` and select **Apply filters**. The date fields default to the same complete Current + Archive range as Search. Applying refreshes the catalog and reads only the reports currently available. Expand the report list to exclude individual reports, then search or filter tests by project and sort by duration increase, latest duration, or name.

The selected test shows its chart, run history, individual attempts, and two metrics:

- **Passed attempt** uses the duration of the actual successful attempt, including successful retries. A failed or skipped execution has no passed duration.
- **Total incl. retries** sums the attempt durations, matching the Playwright report's displayed test duration. Missing tests and skipped executions are gaps, not zeroes.

The baseline is the median of the first five earlier passing runs among the included reports, excluding the latest report. Expected failures and unexpected passes are excluded from that baseline. Insufficient history or a zero baseline produces no percentage comparison. A new test with one execution remains visible with **1 run; trend not available yet**. The latest value always refers to the latest included report, not an older successful execution.

Charts are ordered by report execution time; multiple reports on the same day remain separate points. If execution time is unavailable, the view labels its attempt-time or catalog-time fallback. Imported reports can therefore have execution dates earlier than the catalog date used for filtering.

Tests are matched by project, spec path, full test title, suite context, and repeat index. The changing date in suite suffixes such as `[DEV NA - 6/1]` is normalized while preserving the environment and region. Other title/file/project changes start a separate series. Ambiguous identities are kept separate instead of guessed.

Select a chart point or a run-history date to see that run. **Open test** and **Open attempt** open the exact source test in a new tab. These links continue to work after a report is renamed or archived. A deleted, replaced, or overwritten report produces an unavailable/changed message rather than opening a different run. Unreadable reports are explicitly listed and can be excluded.

Trends are generated on demand and held only in memory. There are no timing tables, retained generations, background indexing, additional folders, or new path preferences. Closing the dialog releases its dataset; the next Apply reads the currently available reports. Step-level trends and backend performance diagnosis are not included.

### Share one test

Use the download icon in the selected test's detail header to export **that test only**, across the included reports, as a single HTML file. The snapshot retains metric switching, chart point selection, attempt timings, statuses, and run history, and opens directly in a browser without the dashboard or a network connection.

The export includes the selected test's name, report names, user-entered metadata, date/filter context, and capture time. It is not anonymized. It excludes other tests, local filesystem paths, source-report links, credentials, errors, traces, and attachments. Deleting the original reports does not affect the snapshot, but it cannot open their original detail pages. Share the file through your organization's approved channels; some mail systems block HTML attachments.

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
