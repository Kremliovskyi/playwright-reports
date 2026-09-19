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

Open **Trends** beside Search in the dashboard header to launch a dedicated browser tab. The original dashboard stays usable and keeps its active Search filter. Refresh and Preferences are compact icon controls; on narrow screens they are in **More actions**. The Trends page also has a **Reports** link back to the dashboard.

Enter metadata such as `DEV NA` and a **Test title contains** value, then select **Search matches**. The required title query is a literal, case-insensitive substring of the test's leaf title (1 to 256 characters), not a regular expression or an inferred test ID. A full title or a stable fragment works across title and file moves. The date fields default to the complete Current + Archive range and use catalog creation dates in UTC.

Search refreshes the catalog and captures matches from the currently available reports. Review the matches before selecting **Generate trend**:

- Choose one Playwright project if the matches contain more than one, even if those projects ran on different dates. The selector receives focus and a highlighted **Required** state; the report table appears after selection. Generate stays muted and disabled until a project and valid matches are selected. A single matching project is selected automatically.
- Expand a report to inspect the original title, suite, file and source location. Counts distinguish logical tests, executions, and attempts.
- Conflicting matches are highlighted with a **Conflict** label. Uncheck an unrelated test to exclude all its executions and retries, or exclude an entire report. Exclusions are reversible and do not change report files.
- Repeated executions of one definition are accepted only when their repeat indices can be distinguished. Copied or legacy unlabelled execution records require review; individual execution records can be excluded, but individual retries cannot.
- An unreadable report blocks generation until excluded. A report with no title match remains a visible gap. A report whose matches are all deliberately excluded is removed from the comparison instead.

Generate uses exactly the captured, reviewed data without fetching it again. Changing a selection hides the generated chart until Generate is selected again. Editing a search field invalidates the preview; another Search is required. A new Search resets exclusions, and changing project resets test/execution exclusions.

After generation, **Search** and **Review matches** collapse to compact summary rows and the chart receives focus and comes into view. Reopen either section to inspect or change the selection; collapsing a section does not discard exclusions. Review uses a bounded scrolling table for larger report sets, and summary counts omit zero-value statuses.

The selected test shows its chart, run history, individual attempts, and two metrics:

- **Passed attempt** uses the duration of the actual successful attempt, including successful retries. A failed or skipped execution has no passed duration.
- **Total incl. retries** sums the attempts within that execution, matching its Playwright report duration. Repetitions are separate points, not added together. Missing tests and skipped executions are gaps, not zeroes.

The baseline gives each report equal weight: calculate the median of eligible passing repetition values within each of the first five earlier eligible reports, then take the median of those five values. The entire latest report, expected failures, and unexpected passes are excluded from the baseline. Insufficient history or a zero baseline produces no percentage comparison. One report with many repetitions is still insufficient cross-report history. The latest value refers to the latest execution in the latest included report, never an older success; a missing latest match remains a gap.

Each point uses the execution's first available attempt timestamp, falling back to report time and then catalog time with a visible label. Same-time executions remain separate in history and can be selected with the chart's arrow keys. Imported reports can therefore have execution dates earlier than the catalog date used for filtering.

Across reports, the title query, chosen project and manual selections define the comparison. No fuzzy title matching or aliases are inferred. Within a report, an exact project, file, suite path, title and source location identify a logical definition. Parameterized titles and identically named tests in different suites remain separate candidates. Use metadata and source inspection to keep environments comparable.

For sharded runs, merge the blob reports into one final Playwright HTML report before importing it. Trends treats that merged HTML as one report; distinct tests from different shards are not duplicates, and retries remain inside their test execution. It does not merge separate shard folders or infer whether every shard completed. Playwright 1.60+ HTML exposes nonzero repeat indices; older HTML may not distinguish repetitions, even though an older blob can retain the indices. Duplicate indices, including copied blob inputs, require manual exclusion rather than being treated as new repetitions.

Select a chart point or a run-history date to see that run. **Open test** and **Open attempt** open the exact source test in a new tab. These links continue to work after a report is renamed or archived. A deleted, replaced, or overwritten report produces an unavailable/changed message rather than opening a different run. Unreadable reports are explicitly listed and can be excluded.

Trends are generated on demand and held only in memory. There are no timing tables, retained generations, background indexing, additional folders, or new path preferences. Closing or reloading the tab releases its dataset; the next Search reads the currently available reports. Step-level trends and backend performance diagnosis are not included.

### Share one test

Use the download icon in the selected test's detail header to export **that test only**, across the included reports, as a single HTML file. The snapshot retains metric switching, chart point selection, attempt timings, statuses, and run history, and opens directly in a browser without the dashboard or a network connection.

The export includes the query, chosen project, retained executions' original titles and relative source context, report names, metadata, date filters, exclusion counts, and capture time. It is not anonymized. It excludes other candidates, original source IDs, absolute filesystem roots, source-report links, credentials, errors, traces, and attachments. Deleting the original reports does not affect the snapshot, but it cannot open their original detail pages. Schema-2 exports retain one point per repetition; existing downloaded schema-1 HTML files keep their embedded viewer and continue to work. Share the file through your organization's approved channels; some mail systems block HTML attachments.

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
