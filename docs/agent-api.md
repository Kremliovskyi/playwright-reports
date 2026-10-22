# Agent API

[Back to documentation](index.md)

The dashboard exposes a local-first API for discovering reports and resolving them into paths that [`playwright-traces-reader`](https://www.npmjs.com/package/@andrii_kremlovskyi/playwright-traces-reader) can analyze.

## Report discovery

### `GET /api/agent/reports/search`

Searches the persisted report index and returns descriptors with an opaque `reportRef` and a stable per-instance `uuid`. References are path-based and may change after a rename/archive; UUIDs survive those moves. Each descriptor also contains `analysisFiles`, an array of available `run-<timestamp>` vault note names.

Parameters: `query` (metadata/date tokens), `scope=current|archive`, `rangeStart`,
`rangeEnd`, `selectedDates` (comma-separated dates), and `limit`. Dates use UTC
catalog creation dates, not necessarily execution dates. Omit `limit` for
history searches: `totalCount` counts returned descriptors only. Search does
not scan disk or refresh the index.

The array shape is unchanged. Reconciled reports have at most one retained analysis; legacy duplicates stay accessible until their removal is explicitly confirmed in **Report Info**. Upgrade does not remove single existing analyses or change their links.

`analysisFiles` and vault endpoints expose final notes only. A grouped-only archive
is retained separately under `analysis/grouped-analysis/` and is accessible through
the dashboard's Info dialog, not these final-note APIs. Report creation dates remain
the original catalog dates across rename/archive; filesystem identity tracking is separate.

### `GET /api/agent/reports/prepare?reportRef=...`

Resolves a selected report descriptor into local analysis-ready values such as the report root and `data/` directory.

Treat `reportRef` as opaque. Do not construct report filesystem paths from it.

## Vault access

- `GET /api/agent/vault/list` lists available Markdown analysis notes.
- `GET /api/agent/vault/:filename` returns one note as raw Markdown.

## Installed Skills

Build this checkout and run `node dist/cli.js init-skills /path/to/project`, or
use `npx playwright-reports init-skills` from a project where this package is
installed. Templates are packaged under `templates/skills/` and copied into
`.github/skills/`. Existing files are skipped; `--force` replaces them.
The default JSON response is `{ schemaVersion: 1, command: "init-skills", skills }`,
where each entry has `name`, absolute `skillPath`, and `status` (`installed` or
`skipped`). `--format text` is also supported.

- `playwright-reports`: report discovery, local preparation and existing vault notes.
- `analyze-playwright-trends`: historical test lookup, timing comparisons and
  exact-attempt trace resolution, with explicit identity and evidence checks.
- `analyze-playwright-traces` is installed separately by the reader. Refresh
  older installations to replace their combined discovery/trace instructions.

These skills use the HTTP API with `curl --fail-with-body --silent --show-error`.
Use the supplied base URL, `PLAYWRIGHT_REPORTS_BASE_URL`, or the local default
`http://127.0.0.1:9333`. The hub must already be running. Local analysis paths
must be consumed on the hub machine.

## Trends And Exact Attempts

### `POST /api/trends`

This is a read-only query. Send `{ "reportUuids": ["<returned uuid>"], "testQuery": "test title fragment" }`.
It accepts at most 500 UUIDs per request and a literal case-insensitive leaf-title
substring of 1-256 characters. Larger inventories require explicit batches;
each response returns all matches with no pagination. It does not run trace
parsing, spawn jobs, extract archives, or update the catalog.

The schemaVersion 2 response contains `reports` (UUID, content `version`,
timestamp/provenance and optional `issue`) and `candidates` (exact testId,
project/source identity, repeat, outcome and attempts). Attempt `index` is the
result-array position; `retry` is recorded Playwright retry metadata. They are
not interchangeable. Durations are milliseconds. `passed` uses the last actually
passed attempt; `total` sums all attempts, or null when all were skipped.

Review candidate identity before merging reports. Keep different projects,
parameters and repeats separate. Unavailable reports and missing tests are
gaps, not zeroes. Catalog dates and test execution timestamps can differ.

### `GET /api/agent/trends/reports/:uuid/attempt`

Required query parameters: `testId`, `version` (the SHA-256 from the trend
preview), `run` (the exact attempt `index`, including an explicit `0`).

```bash
curl --fail-with-body --silent --show-error --get 'http://127.0.0.1:9333/api/agent/trends/reports/<uuid>/attempt' --data-urlencode 'testId=<testId>' --data-urlencode 'version=<version>' --data-urlencode 'run=0'
```

The schemaVersion 1 response has:

- `command: "resolve-trend-attempt"`, `report`, `observation`, `attempt`.
- `analysisTarget: { reportRootPath, reportDataPath }` for reader CLI input.
- `reportUrl` for the corresponding HTML report test/retry.
- `traces: [{ attachmentPath, tracePath, issue }]`. All trace attachments for
  this exact attempt are returned; available ZIPs or extracted directories
  resolve to absolute paths. An unavailable attachment has `tracePath: null`.
- `traceAvailability`: `available`, `not-recorded` (no trace attachments), or
  `missing` (at least one attachment is missing).

The resolver rejects unsafe paths and symbolic links and checks folder identity,
HTML version, and test/attempt existence. Renames and archive moves retain UUID
resolution. Stale/replaced reports return 409; missing reports/tests/attempts
return 404; invalid input/unsafe paths return 400; unsupported report data returns 422. Responses are not cached. Requery on 409 rather than selecting a different
attempt. It never extracts or writes artifacts.

Feed returned trace paths to `playwright-traces-reader digest`, writing outside
the source report. Use the returned digest manifest location. Trace parsing and
screen attribution remain reader responsibilities. No statistical onset or
screen attribution is claimed by this endpoint: those need comparable history
and trace evidence. A single report cannot establish regression onset.

## Compatibility CLI Workflow

The reader retains these hub commands for existing integrations. New report
skills use the reports API directly, so installing them does not depend on
discovery commands in the reader.

```bash
npx playwright-traces-reader search-reports "UAT EU" --limit 1
npx playwright-traces-reader prepare-report <reportRef>
npx playwright-traces-reader failures <reportRootPath>
npx playwright-traces-reader summary <tracePath>
npx playwright-traces-reader vault-read <runName>
```

The intended sequence is:

1. Search for a report in the dashboard's persisted index.
2. Prepare the selected `reportRef` to resolve its local path.
3. Run a `playwright-traces-reader` analysis command against that path.
4. Read a named analysis file when the search result exposes one.

## Responsibility boundary

`playwright-reports` owns report inventory, metadata and date search, and local path resolution. It does not parse traces or reimplement summary, network, DOM, or failure-analysis commands.

Dashboard-generated manual digests share a report-owned `tmp/digests-<reportUuid>/` directory. Agents consuming those paths must not remove that directory as scratch cleanup. Standalone CLI output remains caller-owned and is not subject to dashboard retention.

`playwright-traces-reader` owns trace parsing and higher-level analysis. A future remote-storage implementation can materialize the report behind the same prepare step without changing the parser's contract.

## Verification

`npm test` builds both targets and runs the API, installer, identity, retry,
baseline, stale-source and unsafe-path regression tests in isolated storage.
To exercise every documented trace-skill command on a supplied real report:

```bash
PW_REPORTS_SKILL_REPORT=/absolute/path/to/report \
PW_REPORTS_READER_CLI=/absolute/path/to/playwright-traces-reader/dist/cli.js \
node --test tests/skills.test.js
```

Build both projects first. `PW_REPORTS_READER_CLI` is optional; by default the
test uses the installed reader dependency. The report must include passed and
failed attempts with traces, network, DOM, screenshots and attachments. Outputs
go to temporary storage and are removed. A before/after fingerprint checks file
contents and modification metadata across the source report. This verifies
tool contracts, not the accuracy of an arbitrary agent's final interpretation.
