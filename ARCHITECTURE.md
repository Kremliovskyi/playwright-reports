# Developer Architecture & Design Decisions

This document outlines the core architecture, data flows, and critical design decisions (especially edge cases) involved in building the Playwright Reports Dashboard.

**If you are a future developer or an AI Assistant modifying this codebase, please read this document before altering any data extraction or path resolution logic.**

---

## 🏗️ Core Stack
- **Backend:** Node.js + Express.
- **Frontend:** Vanilla HTML, CSS, and TypeScript (`app.ts` compiled via `tsc`).
- **Database:** Local SQLite (`app.db`), managed via standard SQL queries (no heavy ORMs) to store configurations and Test Presets.
---

## 🗄️ Database Usage (`app.db`)

The application enforces a strictly zero-configuration data model out of the box. Instead of using a heavy ORM or requiring a running database server, we utilize `better-sqlite3` to maintain a localized, synchronous `app.db` file.

- **WAL Mode:** The database is initialized with `journal_mode = WAL` (Write-Ahead Logging) to ensure high concurrent read performance when the frontend dashboard aggressively polls.
- **`config` Table:** Designed to support multiple configurations (e.g., for different teams or projects). The current implementation primarily uses an `id: 'default'` row, but the schema inherently allows scaling to multiple rows containing the physical paths to Current, Archive, and Project root directories, the serialized JSON payload for user-selected Test Runner Options, and BrowserStack credentials (`browserstackUsername`, `browserstackAccessKey`, `browserstackConfig`). BrowserStack columns are added via `ALTER TABLE` with existence checks during migration.
- **`presets` Table:** Stores user-created saved project selections. This allows users to instantly recall groups of test suites without manually checking boxes every time.
- **`reports` Table:** Persists metadata for all scanned reports. It uses the report folder name as the primary `id` — the `id` is both the physical folder name on disk and the exact display label shown as "Report Origin" in the dashboard. No transformation is applied; what is on disk is what is shown. Storing report metadata in SQLite allows for persistent user-entered labels that survive filesystem refreshes and folder moves (archiving).

### Read-only search index

The same `reports` table also powers the dashboard's persistent search/filter UI.

- **Searchable fields:** The search layer currently matches only `metadata` and `dateCreated`.
- **Read-only contract:** The dedicated search route does not call `scanDirectory()`, does not upsert report rows, and does not mutate the filesystem. It only queries the already persisted `reports` rows.
- **Why this matters:** Search can stay fast and safe, while normal dashboard load and explicit Refresh remain the only moments when filesystem-to-database sync occurs.

---

## 📊 Report Metadata & Syncing

The application does not use a "dumb" filesystem scan. It implements a differential sync between the disk and the database.

- **Sync During Scan:** Every time `scanDirectory` is called (during dashboard load or refresh), the system builds a list of reports from the disk and immediately `upserts` them into the `reports` table.
- **Metadata Persistence:** User-entered metadata is stored only in the database. During the sync, the system merges the existing DB metadata back into the scanned objects. This ensures that manually added info like 'UAT NA' remains attached to the report even if the server restarts.
- **Renaming Logic:** Users can rename a current report's origin label directly from the dashboard. The `/api/report-rename` endpoint validates the new name (rejects forbidden filesystem characters: `/ \ : * ? " < > |`, null bytes, and `.`/`..`), performs a path-traversal guard by confirming both source and destination resolve within `appConfig.currentPath`, checks that no folder with the new name already exists (conflict guard), then calls `fs.renameSync` to rename the physical folder. The database record's `id` and `reportPath` are updated atomically via `updateReportId()`. Live validation feedback is shown in the UI before any server call is made.
- **Archiving Logic:** When a report is moved to the Archive via `/api/archive`, the backend physically renames the folder, moving it to the archive root with a timestamp suffix to prevent collisions. The database record is then updated to point to the new folder ID and new physical path, preserving the metadata across the move. If a matching vault analysis file exists, it is moved from the vault directory to `<archivePath>/analysis/`.
- **Deleting Logic:** When a user permanently deletes a report via `/api/delete-report`, the backend uses `fs.rm` with `{ recursive: true, force: true }` to completely wipe the report from disk.
- **Cleanup:** Stale database records (reports that exist in the DB but were deleted manually from the filesystem) are purged during the `scanDirectory` sync to keep the database and UI in perfect alignment.

### Search vs sync boundary

There is an intentional separation between the two dashboard data flows:

- **`GET /api/reports`:** Performs the normal scan-and-sync behavior, merging the filesystem into SQLite before rendering the dashboard.
- **`GET /api/report-search`:** Queries the persisted SQLite rows only and returns the same `{ current, archive, configStatus }` shape as the main dashboard load so the frontend can reuse the same table renderer. Metadata text is matched case-insensitively by whitespace-delimited tokens, with all tokens required to match.

This keeps the filtering UX consistent while preserving the rule that search itself must not update reports.

---

## ⚙️ Preferences Modal — Tabbed Interface

The Preferences modal uses a tabbed layout to organize settings into logical groups without overwhelming a single scrollable form.

- **Tab Structure:** Two tabs — "Paths" (directory configuration) and "BrowserStack" (cloud credentials). The first tab is active by default.
- **Sticky Tab Bar:** The `.modal-tabs` container uses `position: sticky; top: 0` within the scrollable `.modal-body` so tabs remain visible if content overflows.
- **Scrollable Body:** The modal body uses `overflow-y: auto` with `flex: 1; min-height: 0` inside a flex column layout capped at `max-height: 85vh`. This ensures the modal never exceeds viewport bounds regardless of content length.
- **Tab Switching:** Vanilla JS click handlers on `.modal-tab` buttons toggle `active` class on both the button and the corresponding `.modal-tab-content[data-tab-content]` panel.
- **Data Flow:** All fields across all tabs are read/written in a single `GET /api/config` and `POST /api/config` round-trip. Tab selection is purely a presentation concern and is not persisted.

---

## Agent Discovery Boundary

The dashboard exposes a minimal agent-facing contract for report discovery, but intentionally stops short of trace parsing.

Current endpoints:

- `GET /api/agent/reports/search` queries the persisted `reports` table and returns report descriptors plus an opaque `reportRef`. Each descriptor includes an `analysisFile` field (non-null when a matching vault `.md` file exists for that report) so agents can discover analysis files without a separate vault listing call.
- `GET /api/agent/reports/prepare?reportRef=...` resolves a chosen descriptor into local filesystem paths such as `reportRootPath` and `reportDataPath`.
- `GET /api/agent/vault/:filename` returns raw vault markdown content. This endpoint is used by the `vault-read` CLI command in `playwright-traces-reader` to let agents read vault analysis files that live outside the IDE workspace.

Important contract rules:

- The agent API is local-first. Returned paths are intended for immediate local analysis.
- `reportRef` is a hub-owned lookup token. Callers should treat it as opaque and should not derive filesystem paths from it manually.
- The dashboard does not parse traces, compare failures, or implement `summary`, `network`, `dom`, or related analysis flows.
- Those analysis workflows belong to `playwright-traces-reader`, which consumes the resolved local path after `prepare`.

This keeps responsibilities clean:

- `playwright-reports` owns cataloging, metadata persistence, search, and path resolution.
- `playwright-traces-reader` owns parsing and higher-level trace analysis.

If remote storage is added later, this boundary still holds. The `prepare` step can evolve to materialize or proxy the correct local analysis target without changing the parsing CLI contract.

---

## ☑️ Table Selection & Bulk Actions

The Current and Archived tables now maintain independent, frontend-only selection state.

- **Selection Model:** Each row includes a checkbox bound to a `selectedReports` `Set`, keyed by table (`current` or `archive`). The selection state is intentionally not persisted anywhere; it is recalculated from the rendered table and cleared on every full refresh.
- **Shift-click Range Selection:** Checkbox selection supports `Shift + left click` range selection using a per-table anchor. The range is computed only from the rows currently rendered in that specific table, so it naturally respects filtered views and never crosses between Current and Archived tables.
- **Toolbar Controls:** `Select All` is always enabled for visible tables, while `Select None` is enabled only when the corresponding selection set is non-empty. A live selection counter (`N selected`) is shown only when the count is greater than zero.
- **Contextual Actions Menu:** Bulk actions are hidden until at least one row is selected. The Current table exposes `Archive selected` and `Delete selected`; the Archive table exposes only `Delete selected`.
- **Row Interaction Guardrails:** Row clicks still open the report, but clicks originating from checkboxes, metadata inputs, rename inputs, or action buttons are stopped so selection and inline editing do not accidentally navigate away.
- **Selection Integrity During Rename:** Current-report rename mutates the row's `reportPath`. If that row is currently selected, the frontend swaps the old path out of the selection set and inserts the new path immediately so bulk actions continue to target the correct report.
- **Anchor Reset Rules:** The Shift-click anchor is intentionally cleared on full rerenders and row-identity mutations such as refreshes, searches that rerender the table, `Select None`, `Select All`, archive/delete completions, and rename operations. This avoids stale range references after the visible row order changes.

### Why selection is frontend-only

Selection is strictly a transient UI concern. Persisting it in SQLite would add state-recovery complexity without improving the underlying report model, since a page refresh or filesystem sync can legitimately re-order, rename, archive, or remove reports.

---

## 🔎 Persistent Search UI Model

The header search panel behaves as a persistent filter control rather than a temporary modal.

- **Draft vs applied state:** The frontend keeps a distinction between the values currently typed into the open dialog and the values currently applied to the dashboard. This is why the dialog can be closed without clearing the filtered result set.
- **Close behavior:** Clicking the `X` only hides the panel. It does not clear the active filter.
- **Reset behavior:** The explicit `Reset` action clears the applied filter, clears the form values, and restores the cached unfiltered dashboard.
- **Header signal:** When a filter is applied, the Search button remains highlighted so the filtered state is visible even when the dialog is closed.
- **Refresh gating:** Refresh is disabled only while the dialog is open. Once the panel is closed, Refresh is available again even if a filter remains applied.
- **Row actions remain live:** Archive, delete, extract, rename, and metadata editing are still allowed while the dashboard is filtered.

This model reduces layout disruption because the floating panel can be closed while leaving the filtered table view intact.

---

## 🧰 Bulk Archive / Delete Execution Strategy

Bulk archive and delete intentionally reuse the existing single-report backend endpoints instead of introducing batch APIs.

- **No new backend contracts:** The frontend loops through the selected `reportPath` values and calls `/api/archive` or `/api/delete` one report at a time.
- **Sequential execution:** Requests are performed serially to avoid hammering the filesystem with multiple move/delete operations in parallel and to keep behavior aligned with the existing single-report flows.
- **Single refresh after completion:** The dashboard refreshes once at the end of a bulk operation instead of after every item, which keeps the UI stable while preserving the existing scan-and-sync behavior.
- **Shared confirmation modal:** Single delete and bulk delete both use the same modal shell. The frontend injects the title, message, and confirm label dynamically based on the number of selected reports.
- **Busy-state protection:** While a bulk operation is active, the relevant table's selection controls and action buttons are disabled so the user cannot mutate selection mid-flight.

---

## � Full Report Lifecycle

### 1. Report appears on disk
Playwright outputs a folder (e.g. `playwright-report-4`) with an `index.html` into the configured **current directory**.

### 2. Dashboard load → `scanDirectory('current')`
- Reads all subfolders from the current directory.
- Validates each has `index.html` containing `<title>Playwright Test Report</title>`.
- Calls `upsertReport({ id, dateCreated, metadata, reportPath })` — inserts if new, updates path/date on conflict but **preserves existing metadata**.
- Returns `ReportInfo` with `id` and `name` both equal to `dirent.name` — no transformation applied; what is on disk is what is shown.
- Frontend renders `id` as an editable `<input>` in the Current Reports table.

### 3. User renames: `playwright-report-4` → `my-smoke-run`
- Frontend validates immediately (no forbidden chars, not empty) and shows an inline error if invalid — no server round-trip needed.
- `POST /api/report-rename { reportId: 'playwright-report-4', newName: 'my-smoke-run' }`
- Server: path-traversal guard → conflict check → `fs.renameSync(oldFolder, newFolder)`.
- `updateReportId('playwright-report-4', 'my-smoke-run', '/reports/current/my-smoke-run/index.html')` — updates both `id` and `reportPath` in DB atomically.
- Frontend updates the local `report` closure (`id`, `name`, `path`) in-place — no page reload needed.

### 4. User archives: `POST /api/archive { reportPath: '/reports/current/my-smoke-run/index.html' }`
- Extracts folder name `my-smoke-run` from the URL path.
- Generates a unique archive name: `playwright-report-<timestamp>`.
- `fs.renameSync(currentPath/my-smoke-run, archivePath/playwright-report-1773916890669)`.
- `updateReportId('my-smoke-run', 'playwright-report-1773916890669', '/reports/archive/playwright-report-1773916890669/index.html')`.
- DB `id` is now the timestamped archive folder name; **metadata is preserved** across the move.

### 5. Archive table display
- `scanDirectory('archive')` — same mechanism as step 2.
- Archive rows render as a read-only `<span>` (no editable input).
- `name = dirent.name` — shows exactly what's on disk and in DB, no transformation.

---

## 🚀 Integrated Test Runner

The execution engine runs Playwright tests natively on the host machine, piping the output live to the dashboard browser window.

- **Process Spawning:** Tests are launched via standard Node `child_process.spawn`. It leverages `npx playwright test` securely executing inside the user's defined `projectPath`.
- **Windows Polish:** It dynamically handles pathing anomalies by executing `npx.cmd` with `shell: true` exclusively on `win32` platforms.
- **Server-Sent Events (SSE):** The frontend opens an EventSource connection to `/api/logs`. The backend captures stdout/stderr buffers from the spawn output and pushes them down instantly. The UI layer (`xterm.js`) renders these buffers preserving their original ANSI color codes for a perfect native terminal replica.
- **Zombie Process Protection:** Standard `child.kill()` fails to wipe out deep nested browser threads spawned by Playwright, leaving zombie Chromium processes hanging in the background. We imported `tree-kill` to aggressively trace the process PID tree and issue a clean `SIGKILL` when the user clicks 'Stop Tests'.

### Run Tests Button Guard

The **Run Tests** button in the main dashboard header is disabled when `projectPath` is not configured in Preferences. This prevents launching the runner page for a project that cannot execute.

- **State check on load:** `app.ts` fetches `GET /api/config` immediately after the page loads and calls `updateRunTestsBtnForProjectPath(projectPath)`. If the value is empty the button is disabled and its opacity reduced to 0.7.
- **Hover tooltip:** The button is wrapped in a `div.run-tests-wrapper`. When disabled, a `.run-tests-tooltip.show-tooltip` element is revealed on hover via CSS, showing *"Configure in Preferences to enable: Playwright Project Path"* — the same visual pattern used by the BrowserStack checkbox in the runner page.
- **Live update:** `updateRunTestsBtnForProjectPath` is also called after a successful Preferences save so the button re-enables immediately without a page reload.
- **Two independent disable reasons:** The button also disables while a Runner tab is already open (governed by `BroadcastChannel('runner_state')`). The two states are tracked by separate `isProjectPathMissing` and `isRunnerOpen` flags so closing the runner tab does not re-enable the button if the project path is still missing.

### BrowserStack Cloud Execution

When the user enables the BrowserStack checkbox in the runner, the spawned command changes from `npx playwright test ...` to `npx browserstack-node-sdk playwright test ...`. The SDK wraps the local Playwright execution and tunnels it through BrowserStack's infrastructure.

- **Credential Injection:** `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` are injected into the child process `env` from the persisted config (never exposed in the command line or frontend source).
- **Config Argument:** The `--browserstack.config=<filename>` argument is appended to point the SDK at the correct YAML config (e.g., `browserstack.falcons.yml`).
- **Incompatible Options:** BrowserStack cloud runs do not support local-only Playwright flags. When the checkbox is active, the frontend disables Headed, UI Mode, and Debug toggles, and locks the Workers and Repeat inputs. Visual cues (`.bs-disabled` class, tooltip) clearly communicate why these options are unavailable.
- **State Restoration:** When BrowserStack is unchecked, previously selected options are restored to their prior state. The frontend remembers the pre-BrowserStack values so the user does not lose their local configuration.

---

## 🔍 Data Extraction Strategy

Playwright generates static HTML reports. Instead of trying to parse pure HTML tables to find test results, this application extracts the raw JSON data that Playwright embeds inside the `index.html` report.

1. **Base64 Zip Extraction:** Modern Playwright versions append a `<script id="playwrightReportBase64">` tag containing a Base64-encoded ZIP file at the very end of the `.html` file.
2. **In-Memory Unzipping:** The backend uses `adm-zip` to decode this Base64 string and unzip the contents completely in-memory.
3. **JSON Parsing:** Inside the zip, Playwright stores a `report.json` and individual `data/xxxx.json` files for each test. We parse these directly to obtain 100% accurate test failures, metrics, and network traces.

---

## 🧪 Failure Analysis (`playwright-traces-reader` `failures`)

The **Analyze Failures** overflow action (current reports only) runs the installed `@andrii_kremlovskyi/playwright-traces-reader` CLI to digest a report's failing tests into self-contained per-failure folders for AI agents.

- **Endpoint:** `POST /api/failures { reportPath }`.
- **CLI Resolution:** The server resolves the CLI entry via `require.resolve('@andrii_kremlovskyi/playwright-traces-reader')` and joins `cli.js` next to the resolved package main, so it always runs the version installed in `node_modules` (no global dependency).
- **Execution:** It spawns `node cli.js failures <reportRoot> <outputDir> --format json` with `cwd` set to `currentPath`. The request stays open for the full duration — on machines where antivirus scanning or large reports make the command slow, the row progress overlay keeps spinning until the manifest returns.
- **Output Location:** Results are always written to `<currentPath>/tmp` (the Current Reports Directory + `tmp`), created with `fs.mkdirSync(..., { recursive: true })`. The CLI writes a timestamped `run-<timestamp>/` subfolder containing one folder per failed attempt plus an `index.json` manifest.
- **Response:** The server parses the CLI's stdout JSON manifest and returns `{ success, count, runDir, relativeRunDir, failuresUrl, manifest }`. The frontend displays a dedicated Failure Analysis Result Modal upon success, letting the developer copy the relative path to their clipboard or click to view the `index.json` manifest.
- **Boundary Note:** This is one place `playwright-reports` shells out to the parser CLI directly (for a one-click convenience action). The agent discovery API still does not parse traces itself — see the Agent Discovery Boundary section.

---

## 🔍 Selective Trace Digestion (`playwright-traces-reader` `digest`)

Digesting a full test suite with 300–600 tests bulk-style is extremely resource-intensive and produces massive filesystem clutter. To solve this, the dashboard provides a **Selective Trace Digestion** flow:

### 1. Test Discovery (`POST /api/report-tests`)
- **Request payload:** `{ reportPath: string }`
- **Mechanism:** The server runs `playwright-traces-reader find-traces <reportRootPath> ""` to list all tests and trace locations in the report without extracting any traces.
- **UI Presentation:** The frontend renders these tests in a scrollable, searchable list. Searching by test title is performed instantly in-browser to avoid server round-trips.

### 2. On-Demand Digestion (`POST /api/digest-test`)
- **Request payload:** `{ reportPath, tracePath }`
- **Execution:** Spawns `node cli.js digest <tracePath> <outputDir> --report <reportRootPath> --format json` in-memory.
- **Output:** The CLI unzips the targeted trace, parses step events, builds the network NDJSON, and outputs a clean step tree to `<currentPath>/tmp/run-<timestamp>/<test-name>__retry<index>/digest.json`.
- **Token Efficiency & Workflows:** The digested outputs (step tree + companion console & network NDJSONs) are designed for AI agents to reason about test execution without consuming excessive tokens. Providing a structured chronological step tree and parsed HTTP exchanges simplifies complex automation workflows, such as parsing trace API calls to automatically scaffold a `k6` load test from E2E test runs.

---

## 🛡️ Playwright Config Resolution (`jiti`)

To reliably know where a given test project's aria snapshots are stored, and to execute tests accurately, **the dashboard requires Playwright to be installed in the underlying project workspace.**

Furthermore, the backend needs to parse the user's `playwright.config.ts`.
- **The Problem:** Node cannot natively `require()` a TypeScript file without compilation.
- **The Solution:** We use `jiti` to dynamically transpile and import the config on the fly. This is a crucial internal dependency for resolving workspace variables.
- **Aria Path Template:** We specifically read `config.expect?.toMatchAriaSnapshot?.pathTemplate` to determine the exact folder structure Playwright expects for `.yml` snapshot files.

---

## 🚨 Critical Edge Case: Aria Snapshot Parsing

The logic for extracting the "New Snapshot" from a failed `toMatchAriaSnapshot` assertion is **deliberately complex**. Do not attempt to "simplify" it using naive unified diff parsing (e.g., just grabbing `+` lines).

### The "Truncated Diff" Problem
When an aria snapshot fails, Playwright's terminal output (and thus the `error.message` in the JSON) presents a unified diff (using `@@ -x,y +a,b @@` headers). 

**If you try to build the new file purely from this diff, it will fail.** Playwright deliberately *omits* (truncates) matching middle lines of long snapshots in the console output to save space. Reconstructing a file from a truncated diff results in massive chunks of missing DOM lines.

### The Solution: Call Log Extraction
To obtain the **perfect, un-truncated new DOM state**, our parser ignores the leading `@@` diff entirely. 
Instead, it scans down to the `Call log:` block of the error. Emitted inside this block is the literal string value that Playwright evaluated:

```text
Call log:
  - Expect "soft toMatchAriaSnapshot" with timeout 10000ms
  - waiting for locator('body')
    6 × locator resolved to <body>...</body>
      - unexpected value "- link "Skip to main content":    <--- START EXTRACTION
        - /url: javascript:void(0)
        - heading "Get Ready" [level=4]
        ... [THE FULL, COMPLETE DOM STRING] ...               <--- PRECISE YAML
```

Our algorithm (`src/server.ts -> POST /api/aria-snapshots`) finds `- unexpected value "` and extracts the literal string, reading until it hits the terminating unescaped `"` quote at the end of the block. **Do not modify this extraction strategy.**

---

## 📂 Aria Snapshot Path Resolution

When a test has *multiple* `toMatchAriaSnapshot` assertions, identifying *which* file actually failed is tricky.

1. **Codeframe Extraction:** The backend examines the `error.codeframe` block to find the exact line that failed (marked with `^ Error:` or `>`). It specifically searches the surrounding 5 lines for `name: 'filename.yml'`.
2. **Content Fallback:** If the codeframe is missing or ambiguous, the system parses the `- Expected` lines from the error log and manually scans the test's snapshots directory (`src/test-data/aria-snapshots/...`). It reads every `.yml` file and returns the one whose text content exactly matches the expected block.

---

## 💅 Frontend "Deep Equal" UI & Diff View

When developers fix aria snapshots, it's essential to understand exactly what changed and frequently they want to enforce `deep-equal` checking across the entire body.

- **Diff View:** Instead of presenting users a raw editable textarea containing the new snapshot, the frontend computes a live Longest Common Subsequence (LCS) diff between the expected snapshot on disk and the new snapshot in the error. Removed lines are highlighted green, and added lines are highlighted red to exactly match the terminal and Playwright HTML report conventions.
- **Deep Equal Checkbox:** The Preview UI Modal includes a "Deep Equal" checkbox in the footer. It is `checked` by default.
- **Dynamic Processing:** The `app.ts` logic detects this checkbox and dynamically prepends `- /children: deep-equal\n` to the top of the diff output. It executes this *without* triggering diff highlighting (so it appears as regular text), ensuring the user can apply the validation globally with a single click before submitting to the `/api/fix-aria-snapshot` endpoint.
- **Indentation Normalization:** The expected snapshot (read from the `.yml` file on disk) uses 4-space YAML indentation (as enforced by the project's snapshot rules), while the new snapshot extracted from Playwright's error output always uses 2-space indentation. Before the LCS diff runs, both strings are passed through `normalizeIndent()` which detects the minimum indent unit and normalises everything to 2-space. This ensures virtually all unchanged lines match exactly and the diff highlights only genuine content differences. **The Apply Fix path is not affected** — the 2-space string from Playwright's error output is saved directly, which is what Playwright itself expects when re-running tests.
- **CRLF Normalization:** On Windows, Git's default `core.autocrlf=true` checks out `.yml` snapshot files with `\r\n` line endings. The new snapshot extracted from Playwright's error log is always LF-only (each extracted line is already stripped of `\r`). Without normalization, `computeDiff` splits by `\n` and compares e.g. `"  - radio \"Passport\"\r"` vs `"  - radio \"Passport\""` — the LCS finds zero matches, causing every line to show as removed/added. To prevent this, `fs.readFileSync` in `server.ts` applies `.replace(/\r\n/g, '\n').replace(/\r/g, '\n')` immediately after reading the expected snapshot from disk. As a belt-and-suspenders measure, `normalizeIndent()` and `computeDiff()` in `app.ts` also normalize their inputs before splitting, making the diff immune to CRLF regardless of data source.

---

## 📓 Vault Integration (Markdown Analysis Files)

The dashboard integrates with an Obsidian-style vault directory for storing per-report analysis notes as Markdown files.

### Configuration

- **Vault Path:** Configured in Preferences alongside other paths. Stored in the `config` table as `vaultPath`. The DB migration adds the column via `ALTER TABLE` with an existence check.
- **File Matching:** The frontend fetches the vault file list at dashboard load and matches filenames against report origin labels to conditionally show an "Analysis" action in the overflow menu.

### Server-Side Rendering

- **markdown-it:** Markdown files are rendered server-side using `markdown-it` with `html: true`, `linkify: true`, and `typographer: true`.
- **Vault Page:** `GET /vault/:filename` returns a full standalone HTML page with dark theme, rendered markdown, and an inline edit/save UI.
- **Edit Mode:** The page includes a `<textarea>` pre-filled with the raw markdown. Save writes back to disk via `PUT /api/vault/:filename`. The textarea uses `min-height: 80vh` for comfortable editing.

### API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/vault/list` | GET | Lists `.md` files in the vault directory with modification times |
| `/api/vault/:filename/raw` | GET | Returns raw markdown as `text/markdown` |
| `/api/vault/:filename` | PUT | Writes `req.body.content` back to disk |
| `/vault/:filename` | GET | Renders full HTML page with markdown-it |
| `/api/agent/vault/list` | GET | Agent-facing vault file listing |
| `/api/agent/vault/:filename` | GET | Agent-facing raw file content (used by `vault-read` CLI) |

### Security

- **Path Traversal Guard:** `resolveVaultFile()` applies `path.basename()` then `path.resolve()` and verifies the result starts with the configured vault directory. This prevents directory traversal attacks via crafted filenames.

### Archive-Aware File Relocation

Vault `.md` files are named after the report origin label (e.g., `playwright-report.md`). When a report is archived, the backend renames the origin folder to a timestamped name (e.g., `playwright-report-1773916890669`). The archive endpoint moves the matching vault file from `<vaultPath>/<oldName>.md` to `<archivePath>/analysis/<newArchivedName>.md`, creating the `analysis/` directory if it does not exist. This keeps archived analysis files co-located with their archived reports rather than cluttering the active vault directory. The move includes an EXDEV cross-drive fallback (copy + delete) and is wrapped in a try/catch — a vault file failure does not block the archive operation itself.

### Dual-Location Vault Resolution

`resolveVaultFile()` checks both `<vaultPath>` (for current reports) and `<archivePath>/analysis/` (for archived reports) when resolving a filename. The vault list endpoints (`/api/vault/list` and `/api/agent/vault/list`) merge files from both locations. The save endpoint (`PUT /api/vault/:filename`) resolves existing files from either location before writing; new files default to `vaultPath`.

---

## Row Actions: Inline Buttons + Overflow Menu

Report row actions use a three-tier pattern: inline action buttons for frequently used operations, a primary "View Report →" link, and a "⋯" overflow trigger for less common actions.

### Inline Buttons

- **Analysis** (conditional on vault file match): Opens the vault viewer in a new tab. Rendered as a compact `btn-inline-action` button.
- **Archive** (current reports only): Triggers the archive flow with a row progress overlay. Rendered as a compact `btn-inline-action` button.

### Overflow Menu

The "⋯" trigger reveals a dropdown panel for secondary actions.

#### Positioning Strategy

- **`position: fixed`:** The overflow panel uses fixed positioning relative to the viewport rather than absolute positioning relative to the table cell. This is necessary because `.table-container` uses `overflow: hidden` for border-radius clipping, which would clip an absolutely-positioned dropdown.
- **Dynamic Placement:** On click, the panel's `top`/`right` coordinates are calculated from the trigger button's `getBoundingClientRect()`. If the panel would overflow the viewport bottom, it flips upward by setting `bottom` instead of `top`.
- **Cleanup:** All open panels are closed before opening a new one. Document click and Escape key close any open panel.

#### Menu Contents

- **Current Reports:** Extract, Fix Snapshots, Analyze Failures, divider, Delete (danger style).
- **Archived Reports:** Extract, divider, Delete (danger style).

### Row Progress Overlay

All single-row async actions (Extract, Archive, Fix Snapshots, Analyze Failures) display a unified progress overlay that covers the entire table row instead of modifying individual button text.

- **Overlay Element:** A `div.row-progress-overlay` inside each row's `<td class="col-action">`, containing a spinner and status text.
- **States:** `progress-active` (spinner + message), `progress-success` (green background, success text, no spinner), `progress-error` (red background, error text, no spinner).
- **Auto-Dismiss:** Success and error states auto-dismiss after 2 seconds.
- **Helpers:** `showRowProgress(row, message)` and `hideRowProgress(row, status, message)` encapsulate the overlay lifecycle.
