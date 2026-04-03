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
- **`config` Table:** Designed to support multiple configurations (e.g., for different teams or projects). The current implementation primarily uses an `id: 'default'` row, but the schema inherently allows scaling to multiple rows containing the physical paths to Current, Archive, and Project root directories, as well as the serialized JSON payload for user-selected Test Runner Options.
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
- **Archiving Logic:** When a report is moved to the Archive via `/api/archive`, the backend physically renames the folder, moving it to the archive root with a timestamp suffix to prevent collisions. The database record is then updated to point to the new folder ID and new physical path, preserving the metadata across the move.
- **Deleting Logic:** When a user permanently deletes a report via `/api/delete-report`, the backend uses `fs.rm` with `{ recursive: true, force: true }` to completely wipe the report from disk.
- **Cleanup:** Stale database records (reports that exist in the DB but were deleted manually from the filesystem) are purged during the `scanDirectory` sync to keep the database and UI in perfect alignment.

### Search vs sync boundary

There is an intentional separation between the two dashboard data flows:

- **`GET /api/reports`:** Performs the normal scan-and-sync behavior, merging the filesystem into SQLite before rendering the dashboard.
- **`GET /api/report-search`:** Queries the persisted SQLite rows only and returns the same `{ current, archive, configStatus }` shape as the main dashboard load so the frontend can reuse the same table renderer. Metadata text is matched case-insensitively by whitespace-delimited tokens, with all tokens required to match.

This keeps the filtering UX consistent while preserving the rule that search itself must not update reports.

## Agent Discovery Boundary

The dashboard exposes a minimal agent-facing contract for report discovery, but intentionally stops short of trace parsing.

Current endpoints:

- `GET /api/agent/reports/search` queries the persisted `reports` table and returns report descriptors plus an opaque `reportRef`.
- `GET /api/agent/reports/prepare?reportRef=...` resolves a chosen descriptor into local filesystem paths such as `reportRootPath` and `reportDataPath`.

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

## �🚀 Integrated Test Runner

The execution engine runs Playwright tests natively on the host machine, piping the output live to the dashboard browser window.

- **Process Spawning:** Tests are launched via standard Node `child_process.spawn`. It leverages `npx playwright test` securely executing inside the user's defined `projectPath`.
- **Windows Polish:** It dynamically handles pathing anomalies by executing `npx.cmd` with `shell: true` exclusively on `win32` platforms.
- **Server-Sent Events (SSE):** The frontend opens an EventSource connection to `/api/logs`. The backend captures stdout/stderr buffers from the spawn output and pushes them down instantly. The UI layer (`xterm.js`) renders these buffers preserving their original ANSI color codes for a perfect native terminal replica.
- **Zombie Process Protection:** Standard `child.kill()` fails to wipe out deep nested browser threads spawned by Playwright, leaving zombie Chromium processes hanging in the background. We imported `tree-kill` to aggressively trace the process PID tree and issue a clean `SIGKILL` when the user clicks 'Stop Tests'.

---

## 🔍 Data Extraction Strategy

Playwright generates static HTML reports. Instead of trying to parse pure HTML tables to find test results, this application extracts the raw JSON data that Playwright embeds inside the `index.html` report.

1. **Base64 Zip Extraction:** Modern Playwright versions append a `<script id="playwrightReportBase64">` tag containing a Base64-encoded ZIP file at the very end of the `.html` file.
2. **In-Memory Unzipping:** The backend uses `adm-zip` to decode this Base64 string and unzip the contents completely in-memory.
3. **JSON Parsing:** Inside the zip, Playwright stores a `report.json` and individual `data/xxxx.json` files for each test. We parse these directly to obtain 100% accurate test failures, metrics, and network traces.

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
