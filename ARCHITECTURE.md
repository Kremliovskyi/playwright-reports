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
- **`config` Table:** Designed to support multiple configurations (e.g., for different teams or projects). The current implementation primarily uses an `id: 'default'` row, but the schema inherently allows scaling to multiple rows containing the physical paths to Current, Archive, and Project root directories, the serialized JSON payload for user-selected Test Runner Options, BrowserStack credentials (`browserstackUsername`, `browserstackAccessKey`, `browserstackConfig`), and Copilot settings (`copilotToken`, `copilotModel` for small per-trace analysis, and `copilotBigModel` for run-level grouping). BrowserStack and Copilot columns are added via `ALTER TABLE` with existence checks during migration.
- **`presets` Table:** Stores user-created saved project selections. This allows users to instantly recall groups of test suites without manually checking boxes every time.
- **`reports` Table:** Persists metadata for all scanned reports. The primary `id` is the report folder name — it is both the physical folder name on disk and the exact display label shown as "Report Origin" in the dashboard. No transformation is applied; what is on disk is what is shown. Because folder names are frequently recycled (a report is deleted and a new run is later written to the same `playwright-report_2`/`_3` folder), the table also stores a **`uuid`** column that is the *stable per-instance identity* of a report. `analysis_runs` and `digests` are keyed by this `uuid`, never by the recyclable folder name. Storing report metadata in SQLite allows for persistent user-entered labels that survive filesystem refreshes and folder moves (archiving).
- **`digests` Table:** Persists one row per saved trace digest (`id`, `reportId` = report `uuid`, `runDir`, `folder`, `testTitle`, `createdAt`). A digest's on-disk location is `path.join(runDir, folder)` under the ephemeral `<currentPath>/tmp/`. Rows are written by `/api/digest-test` after a successful digest and are surfaced in the report's Info dialog. Like `analysis_runs`, they are keyed by the stable `uuid` so they survive renames and archive moves of the folder name, and are removed on report delete/archive and by an orphan prune on each scan.

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
- **Renaming Logic:** Users can rename a current report's origin label directly from the dashboard. The `/api/report-rename` endpoint validates the new name (rejects forbidden filesystem characters: `/ \ : * ? " < > |`, null bytes, and `.`/`..`), performs a path-traversal guard by confirming both source and destination resolve within `appConfig.currentPath`, checks that no folder with the new name already exists (conflict guard), then calls `fs.renameSync` to rename the physical folder. The database record's `id` and `reportPath` are updated atomically via `updateReportId()`. The report's `uuid` is **unchanged**, so all `analysis_runs` stay mapped across the rename without any remapping step. Live validation feedback is shown in the UI before any server call is made.
- **Archiving Logic:** When a report is moved to the Archive via `/api/archive`, the backend physically renames the folder, moving it to the archive root with a timestamp suffix to prevent collisions. The database record is then updated to point to the new folder ID and new physical path, preserving the metadata across the move. Because `analysis_runs` are keyed by the stable `uuid` (which does not change on archive), the run mapping is preserved automatically — no `reportId` rewrite is performed. If a matching vault analysis file exists, it is moved from the vault directory to `<archivePath>/analysis/`. Trace `digests` live under the ephemeral `<currentPath>/tmp/` and cannot follow the report into the archive, so they are removed (directories + rows) via `purgeReportDigests()` — the same cleanup as a delete.
- **Deleting Logic:** When a user permanently deletes a report via `/api/delete-report`, the backend uses `fs.rm` with `{ recursive: true, force: true }` to completely wipe the report from disk, and removes the report's `analysis_runs` by its `uuid`. For each run it also unlinks the mapped vault `.md` file and removes the ephemeral output directory (`runDir`) — the latter guarded by `isWithin(currentPath, runDir)` and wrapped in try/catch so a stray output dir never blocks the delete. The report's `digests` are removed by the same `uuid` via `purgeReportDigests()`, which best-effort deletes each digest's `runDir` (guarded by `isWithin(currentPath, runDir)`) before dropping the rows.
- **Cleanup:** Stale database records (reports that exist in the DB but were deleted manually from the filesystem) are purged during the `scanDirectory` sync, along with their `analysis_runs` and `digests` (deleted by `uuid` via `purgeReportRuns()`/`purgeReportDigests()`). A final `pruneOrphanAnalysisRuns()` and `pruneOrphanDigests()` pass each scan drops any run/digest rows whose `reportId` no longer maps to a live report `uuid`, keeping the database and UI in perfect alignment.

### Search vs sync boundary

There is an intentional separation between the two dashboard data flows:

- **`GET /api/reports`:** Performs the normal scan-and-sync behavior, merging the filesystem into SQLite before rendering the dashboard.
- **`GET /api/report-search`:** Queries the persisted SQLite rows only and returns the same `{ current, archive, configStatus }` shape as the main dashboard load so the frontend can reuse the same table renderer. Metadata text is matched case-insensitively by whitespace-delimited tokens, with all tokens required to match.

This keeps the filtering UX consistent while preserving the rule that search itself must not update reports.

### Stable Per-Instance Identity (`uuid`)

The report folder name is **not** a stable identity. Reports are deleted and recreated constantly — sometimes outside the dashboard entirely (IDE, file explorer) — and a new run frequently lands in a recycled folder name such as `playwright-report_2` or `playwright-report_3`. Keying analysis runs by folder name caused a deleted report's runs to "resurrect" on a brand-new, unrelated report that happened to reuse the name, showing stale `(missing on disk)` rows.

To fix this, each report row carries a surrogate `uuid` and a birth timestamp (`dateCreated`, from the folder's `birthtime`):

- **Instance detection on scan:** In `scanDirectory`, a folder is matched to its DB row by name. The existing `uuid` is reused **only** when the stored `dateCreated` still equals the folder's current `birthtime`. If the birthtime differs (e.g. a rerun regenerated the `playwright-report` folder, or a recycled name now points at a physically new folder), the old instance is purged via `purgeReportRuns()` — which best-effort removes each run's ephemeral output dir (guarded by `isWithin(currentPath, runDir)`) and deletes the `analysis_runs` rows — then a fresh `uuid` is minted.
- **Out-of-band deletes:** Because reconciliation is scan-driven rather than event-driven, a report deleted in the IDE/explorer is cleaned up on the next dashboard load — no delete hook is required. Its DB row and runs are removed (output dirs purged via the same `purgeReportRuns()` helper) when the folder is found missing, and a later same-named folder gets a new identity.
- **Stable across rename/archive:** Renaming or archiving changes the folder name (`id`) but never the `uuid`, so the run mapping survives folder moves with no remapping.
- **Orphan prune:** Every scan ends with `pruneOrphanAnalysisRuns()`, deleting any run whose `reportId` no longer matches a live report `uuid`.
- **Migration:** The `uuid` column is added via `ALTER TABLE` with an existence check and backfilled with fresh UUIDs for pre-existing rows. Legacy `analysis_runs` keyed by folder name no longer match any `uuid` and are removed by the orphan prune on first scan (a one-time loss of the old name-based mappings).

---

## ⚙️ Preferences Modal — Tabbed Interface

The Preferences modal uses a tabbed layout to organize settings into logical groups without overwhelming a single scrollable form.

- **Tab Structure:** Three tabs — "Paths" (directory configuration), "BrowserStack" (cloud credentials), and "Copilot" (optional GitHub token for the Copilot SDK). The first tab is active by default.
- **Sticky Tab Bar:** The `.modal-tabs` container uses `position: sticky; top: 0` within the scrollable `.modal-body` so tabs remain visible if content overflows.
- **Scrollable Body:** The modal body uses `overflow-y: auto` with `flex: 1; min-height: 0` inside a flex column layout capped at `max-height: 85vh`. This ensures the modal never exceeds viewport bounds regardless of content length.
- **Tab Switching:** Vanilla JS click handlers on `.modal-tab` buttons toggle `active` class on both the button and the corresponding `.modal-tab-content[data-tab-content]` panel.
- **Data Flow:** All fields across all tabs are read/written in a single `GET /api/config` and `POST /api/config` round-trip. Tab selection is purely a presentation concern and is not persisted.

---

## 🤖 Copilot Access & Model Selection

The header hosts a **Copilot** chip next to Run Tests. It is an access indicator only; model selection belongs to Preferences.

### Preflight (`GET /api/copilot-status`)

- **Mechanism:** The endpoint calls `copilotAccessCheck()` (`src/copilot-analyzer.ts`), which starts a `CopilotClient` (using `copilotToken` when set, otherwise the host login) and reads authentication status without listing models.
- **`ok` semantics:** `ok = authenticated`.
- **Auto check on load:** The chip runs automatically and shows `Copilot: ready`, `Copilot: sign in`, or `Copilot: error`. Clicking it only repeats the access check.

### Model selection dialog

- **Preferences fields:** The Copilot tab has Small Model (`copilotModel`) and Big Model (`copilotBigModel`) fields. Small creates per-attempt records; big performs run-level grouping. The same model ID is valid in both roles.
- **Discovery:** Clicking either field calls `GET /api/copilot-models`, then opens the shared role-aware picker. Model listing is not part of the header status check.
- **Selection rules:** Clicking a model immediately uses merge-style `POST /api/config` persistence for only the targeted field. There is no first-model fallback or stale-selection replacement.
- **Analysis wiring:** `/api/failures` starts one client, authenticates, lists models once, and validates both exact selections before creating the digest output directory. A missing or unavailable selection returns `COPILOT_MODEL_UNAVAILABLE` with `modelRole: "small" | "big"`. The validated client remains alive for all per-trace sessions and the final grouping session.

---

## Agent Discovery Boundary

The dashboard exposes a minimal agent-facing contract for report discovery, but intentionally stops short of trace parsing.

Current endpoints:

- `GET /api/agent/reports/search` queries the persisted `reports` table and returns report descriptors plus an opaque `reportRef`. Each descriptor includes an `analysisFiles` field — an array of run names (`run-<timestamp>`) whose matching vault `.md` file exists for that report — so agents can discover analysis files without a separate vault listing call. Run directories are persisted per report in the `analysis_runs` table (keyed by the report's stable `uuid`) each time **Analyze Failures** runs, and analysis files are mapped by run-directory basename (`run-<timestamp>.md`) rather than by report name. A run's `runDir` column is cleared (set empty) when its output directory is deleted via the Info dialog or removed during archive, but the row \u2014 and thus the analysis-file mapping \u2014 is retained.
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

## 🧮 Archive Capacity Limit

The archive is capped at a fixed maximum of **20 reports**. The cap is enforced entirely on the frontend (`app.ts`) and reuses the existing `/api/reports` and `/api/delete` endpoints — no new backend contracts.

- **Constants:** `ARCHIVE_LIMIT = 20` and `MIN_PRUNE = 5` are module-level constants in `app.ts`. The prune floor exists so the dialog does not reappear on every single archive once the archive is full.
- **Single gate (`ensureArchiveCapacity(incoming)`):** Both the inline single-report Archive button (`handleArchive`, `incoming = 1`) and the bulk **Archive selected** action (`incoming = selectedPaths.length`) await this guard before any move happens. It returns `true` only when archiving may proceed (after any pruning), and `false` when the user cancels or the request is disallowed.
- **Fresh count per click:** Capacity is checked against a freshly fetched `GET /api/reports` archive list at the moment of clicking, **not** the cached `cachedReportsData`. This avoids acting on a stale render when the archive changed in another tab or on disk.
- **Hard block for oversized bulk:** Because a single operation can never leave the archive within the limit when `incoming > 20`, that case is rejected outright with an info-only dialog (single **Close** button) — nothing is deleted or archived. The user must select fewer reports.
- **Prune-to-fit rule:** When `archivedCount + incoming > 20`, the guard computes `deleteCount = min(archivedCount, max(MIN_PRUNE, archivedCount + incoming − ARCHIVE_LIMIT))`. The `max(..., needed)` term guarantees the post-archive total never exceeds 20; the `MIN_PRUNE` floor gives breathing room. `deleteCount` is capped at `archivedCount` since you cannot delete more than exist.
- **"Oldest" definition:** `scanDirectory` returns the archive newest-first, so the oldest reports are at the **end** of the list — exactly the bottom rows of the Archived table the user sees. The guard slices the last `deleteCount` paths and deletes them via the existing serial `performDeleteRequests` loop.
- **Confirmation dialog (`#archive-limit-modal`):** A dedicated modal (mirroring the delete modal shell) serves two modes: a **prune-confirm** mode with a dynamic message stating the exact number to delete plus a danger "Yes, delete N" button, and an **info/block** mode with a single Close button. On confirm it deletes the oldest reports inline (button shows a spinner), then resolves so the original archive flow continues. On cancel it resolves without touching anything, letting the user prune manually.

This keeps the limit authoritative (fresh count), bounded (never exceeds 20), and non-destructive without explicit consent.

---

## � Full Report Lifecycle

### 1. Report appears on disk
Playwright outputs a folder (e.g. `playwright-report-4`) with an `index.html` into the configured **current directory**.

### 2. Dashboard load → `scanDirectory('current')`
- Reads all subfolders from the current directory.
- Validates each has `index.html` containing `<title>Playwright Test Report</title>`.
- Resolves the report's stable `uuid`: reuses the existing one when the folder's `birthtime` still matches the stored `dateCreated`; otherwise (recycled name / physically new folder) mints a fresh `uuid` and drops the old instance's `analysis_runs`.
- Calls `upsertReport({ id, uuid, dateCreated, metadata, reportPath })` — inserts if new, updates `uuid`/path/date on conflict but **preserves existing metadata**.
- Returns `ReportInfo` with `id` and `name` both equal to `dirent.name` — no transformation applied; what is on disk is what is shown.
- Frontend renders `id` as an editable `<input>` in the Current Reports table.

### 3. User renames: `playwright-report-4` → `my-smoke-run`
- Frontend validates immediately (no forbidden chars, not empty) and shows an inline error if invalid — no server round-trip needed.
- `POST /api/report-rename { reportId: 'playwright-report-4', newName: 'my-smoke-run' }`
- Server: path-traversal guard → conflict check → `fs.renameSync(oldFolder, newFolder)`.
- `updateReportId('playwright-report-4', 'my-smoke-run', '/reports/current/my-smoke-run/index.html')` — updates both `id` and `reportPath` in DB atomically. The `uuid` is untouched, so analysis runs remain mapped.
- Frontend updates the local `report` closure (`id`, `name`, `path`) in-place — no page reload needed.

### 4. User archives: `POST /api/archive { reportPath: '/reports/current/my-smoke-run/index.html' }`
- Before the request, the frontend runs `ensureArchiveCapacity(1)` (see Archive Capacity Limit). If the archive is at/over its 20-report cap, the prune-confirm dialog deletes the oldest archived reports first; if the user cancels, no `/api/archive` call is made.
- Extracts folder name `my-smoke-run` from the URL path.
- Generates a unique archive name: `playwright-report-<timestamp>`.
- `fs.renameSync(currentPath/my-smoke-run, archivePath/playwright-report-1773916890669)`.
- `updateReportId('my-smoke-run', 'playwright-report-1773916890669', '/reports/archive/playwright-report-1773916890669/index.html')`.
- DB `id` is now the timestamped archive folder name; **metadata is preserved** across the move, and the stable `uuid` keeps every `analysis_runs` row mapped without a rewrite.

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
- **Execution:** After strict Copilot model validation succeeds, it spawns `node cli.js failures <reportRoot> <outputDir> --format json` with `cwd` set to `currentPath`. The request stays open for the full duration — on machines where antivirus scanning or large reports make the command slow, the row progress overlay keeps spinning until the manifest returns.
- **Output Location:** Results are always written to `<currentPath>/tmp` (the Current Reports Directory + `tmp`), created with `fs.mkdirSync(..., { recursive: true })`. The CLI writes a timestamped `run-<timestamp>/` subfolder containing one folder per failed attempt plus an `index.json` manifest.
- **AI Analysis (Copilot SDK):** After the CLI digest completes, the dashboard runs a per-trace AI analysis (`src/copilot-analyzer.ts` → `analyzeRun`) over each **analyzable** failure (Before Hooks and `outcome: "skipped"` entries are excluded). `index.json` is the run manifest used to select and order attempts, drive progress, and retain retry/outcome metadata; it is not an issue source. For each selected folder, `error.md` is the exclusive source of the model's `issues` array: one output issue must correspond to one fenced block under `# Error details`. The prompt states the exact expected block count, and code rejects a response whose issue count differs. A sanitized projection of `failure.json` supplies supporting test metadata, step-title ancestry, and screenshot/file anchors only; top-level diagnostic collections and every nested step `error` payload are removed before prompting so propagated parent errors or later trace diagnostics cannot become extra issues. Relevant network-error data remains separate supporting evidence and cannot create an issue. For every analyzable folder the dashboard writes an **`ai-analysis.md`** next to `error.md` — a distilled "understanding record" (step path, deepest failing step, error verbatim/normalized, network table, issues list, final page state, transient-vs-final contradiction check, root cause hypothesis, and discriminators) produced only by the exact model persisted as `copilotModel`. Analysis never selects or persists a fallback model. The `index.json` manifest is left untouched — the analysis lives entirely in the per-folder `ai-analysis.md` files. If the model fails for a folder or violates the issue-count contract, that folder's `ai-analysis.md` records a `⚠️ AI analysis failed` note plus an error block so a downstream reduce step can fall back to the raw files.
- **Concurrent analysis (3-way pool):** The per-trace analysis runs through a bounded worker pool of `ANALYSIS_CONCURRENCY = 3` (hardcoded in `copilot-analyzer.ts`) rather than a sequential loop. Each failure folder is fully isolated — it reads only its own input files (`failure.json`, `error.md`, network json), creates its **own** Copilot session, and writes only its own `ai-analysis.md` — so the three in-flight analyses never depend on or interfere with each other. One shared `CopilotClient` is created and validated before digesting, stays alive while the CLI runs, and hosts all later sessions (the SDK is multi-session safe); model availability is not queried a second time. The pool is I/O-bound concurrency, not OS threads: three model round-trips overlap on Node's single thread, cutting wall-clock time roughly 3×. A shared `cursor` hands the next folder to each worker; because `cursor++` and the `analyzed`/`failed`/`completed` counters are incremented synchronously between `await`s, no locks are needed. One folder failing (thrown error or AI-failed record) is captured per task and never aborts the others. Progress is reported via a monotonic `completed`/`total` counter (the `failure-analysis` SSE event), so the row label advances steadily even though folders finish out of order.
- **Problem Grouping:** Once all workers finish, `src/copilot-grouper.ts` creates one session using `copilotBigModel` with no tools enabled. The server maps the in-memory understanding records and matching manifest metadata into one compact JSON dataset embedded directly in the prompt; it does **not** send the many `ai-analysis.md` files as separate attachments. The dataset includes every valid issue with its 1-based index, test/retry/outcome metadata, step path, normalized error, network evidence, final page state, root-cause hypothesis, and discriminators. This guarantees that the single reduce call receives the complete groupable evidence without depending on attachment injection. The model returns structured problem-to-issue references, and code deterministically renders `grouped-analysis.md` with manifest-derived retries, outcomes, folder pointers, and reconciliation. Duplicate or unknown references remain invalid. If the model omits otherwise-valid issues, its returned groups are preserved and the missing references are appended as `Unclassified - omitted by grouping model`; per-trace AI failures are separately appended as `Unclassified - per-trace analysis unavailable`. A malformed grouping response or SDK failure is still non-fatal and never removes completed per-trace output.
- **Response:** The server returns the manifest, per-trace summary, and either grouped-report metadata or a non-fatal `groupingError`. The completion dialog links both `index.json` and `grouped-analysis.md` when grouping succeeds.
- **Lifecycle:** `grouped-analysis.md` lives inside the run directory and appears in the completion and Report Info dialogs. It is ephemeral and is deleted with the output directory or during archive cleanup; it is separate from the durable vault Analysis file.
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
- **Persistence:** On success the server records the digest in the `digests` table against the report's stable `uuid` (`runDir`, `folder`, `testTitle`, `createdAt`). This makes every digest discoverable in the report's **Info** dialog and subject to the same lifecycle cleanup as analysis runs (removed on report delete/archive, pruned when orphaned).
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

Archiving also removes each run's ephemeral output directory (`runDir`) from disk and clears its `runDir` reference via `clearAnalysisRunDir()`, while keeping the row so the archived report still maps to its (now relocated) analysis file. The report-size cache is invalidated for the archived report id.

**Clear is unconditional.** The physical `fs.rmSync(runDir)` and the DB `clearAnalysisRunDir()` are deliberately split: `clearAnalysisRunDir()` runs *outside* the `try/catch` that wraps the removal, so the `runDir` reference is detached even when the physical delete throws (a common Windows scenario — a locked file, partial deletion, or antivirus hold). If the clear were left inside the same `try` after `rmSync`, a throw would skip it, leaving a stale `runDir` that points at a now-gone directory. That stale row surfaces as a misleading `(missing on disk)` badge in the report's Info dialog even though the output dir was intentionally dropped on archive.

### Dual-Location Vault Resolution

`resolveVaultFile()` checks both `<vaultPath>` (for current reports) and `<archivePath>/analysis/` (for archived reports) when resolving a filename. The vault list endpoints (`/api/vault/list` and `/api/agent/vault/list`) merge files from both locations. The save endpoint (`PUT /api/vault/:filename`) resolves existing files from either location before writing; new files default to `vaultPath`.

---

## Row Actions: Inline Buttons + Overflow Menu

Report row actions use a three-tier pattern: inline action buttons for frequently used operations, a primary "View Report →" link, and a "⋯" overflow trigger for less common actions.

### Inline Buttons

- **Info** (always shown): Opens the Report Info dialog for that report (folder size + analysis runs). Rendered as a compact `btn-inline-action` button; the label shows a run count suffix (e.g. `Info (2)`) when the report has persisted analysis runs.
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

### Generic Error Dialog

Row-level failure states are deliberately terse ("Analysis failed", "Archive failed") and auto-dismiss after 2 seconds — the actual server error message (e.g. an ENOSPC disk-full failure from the `failures` CLI) used to be visible only in the browser's network tab. A shared error modal now surfaces the full message.

- **Modal:** `#error-modal` in `index.html` — standard modal shell with a title and a scrollable, monospace, pre-wrap message body (`.error-modal-message`) so multi-line CLI stderr stays readable.
- **Helper:** `showErrorDialog(title, error)` in `app.ts` sets the title, renders `error.message` (or the stringified value), and opens the modal. Close via header ✕ or footer Dismiss.
- **Wired into every row-level catch:** Analyze Failures (`handleFailures`), Extract (`handleExtract`), Archive (`handleArchive` — this replaced an older ad-hoc `alert()`), Fix Snapshots (`handleFixAria`), and Digest test listing (`handleDigest`). The short row overlay status is kept; the dialog opens alongside it with the details.
- **Partial AI failure is not routed here:** when the failure digest succeeds but the Copilot per-trace analysis fails (`aiError`), the message is already shown inside the Failure Analysis Result Modal ("AI analysis skipped: …").

---

## ℹ️ Report Info Dialog

The per-row **Info** button (always visible) opens a modal that surfaces a report's on-disk footprint and the lifecycle of every analysis run associated with it. It replaces the older "Analysis" dropdown, which only listed vault files.

### Two-artifact lifecycle model

An `analysis_runs` row represents the **report ↔ analysis-file** mapping. Its `reportId` column holds the report's stable `uuid` (not the recyclable folder name), so the mapping survives renames, archive moves, and folder-name recycling. The `runDir` column is a *detachable reference* to the ephemeral failure-analysis output directory (`<currentPath>/tmp/run-<timestamp>/`). The two artifacts have decoupled lifecycles:

- **Output directory** (`runDir`): ephemeral, frequently purged (often daily). Deleting it removes the directory from disk and **clears** the `runDir` column via `clearAnalysisRunDir()`, while keeping the row so the analysis file stays mapped to the report. Deleting the whole report (or archiving it) also removes the output dir from disk, guarded by `isWithin(currentPath, runDir)`.
- **Analysis file** (`<runName>.md`, resolved via `resolveVaultFile()`): long-lived. On archive it is moved into `<archivePath>/analysis/`. Deleting it removes the `.md` from disk; the row is pruned (`deleteAnalysisRun()`) only when the output dir reference is already gone.

Because the report folder (`<currentPath>/<reportId>`) is a **sibling** of `tmp/`, deleting output dirs or analysis files never changes the report folder size.

### Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/report-info?reportId=` | GET | Returns `folderExists`, a `runs[]` array (each with `runDir`, `runDirExists`, `analysisFile`, `analysisFileExists`, `failuresUrl`, `vaultUrl`), and a `digests[]` array (each with `id`, `testTitle`, `createdAt`, `digestDir`, `digestDirExists`, `digestUrl`). Includes runs whose output dir was cleared or whose `.md` is missing. Cheap — no disk scan. |
| `/api/report-size?reportId=` | GET | Recursive byte size of the report folder, **cached** in an in-memory `Map` after first calculation. Pass `?refresh=1` to recompute. |
| `/api/analysis-run/output-dir` | DELETE | `{ reportId, runName }` — validates the dir is within `currentPath`, removes it, clears the `runDir` reference. |
| `/api/analysis-run/analysis-file` | DELETE | `{ reportId, runName }` — validates the file is within `vaultPath`/`archivePath/analysis`, unlinks it, prunes the row if the output dir is already gone. |
| `/api/digest` | DELETE | `{ reportId, digestId }` — validates the digest directory is within `currentPath`, removes it (plus the now-empty `run-<timestamp>` wrapper), and drops the `digests` row. |

### Size calculation & caching

Size is split from `report-info` so the **Analysis runs** section renders immediately instead of blocking on a potentially multi-GB recursive scan. The size loads asynchronously and fills in when ready. The result is cached both server-side (`reportSizeCache`) and client-side (`reportSizeCache` Map). The server cache is invalidated only where the report folder itself is mutated: **extract** (adds unzipped data), **archive**, **rename**, and **delete**. Run/output-dir deletions do not invalidate it.

### Path interactions

Each path row supports three interactions: a visible **copy** button, **right-click → Copy path** (reusing the shared `showAnalysisContextMenu` context menu), and **open** links (the failures `index.json` for an output dir, the rendered `.md` vault page for an analysis file). Missing artifacts show a `(missing on disk)` badge or a muted empty state (`— removed` / `No analysis file`).

**Archived reports never show `(missing on disk)` for an output dir.** An archived report's ephemeral output dir is always intentionally gone (it cannot follow the report into the archive), so any leftover `runDir` is stale by definition. When `/api/report-info` builds the `runs[]` for an archived report (`reportPath` under `/reports/archive/`), it presents a non-existent `runDir` as removed — blanking the path so the row renders the muted `— removed` empty state instead of the alarming `(missing on disk)` badge. This also self-heals rows left stale by older builds that skipped the clear on a failed `rmSync`.

### Delete confirmation

Output-dir and analysis-file deletes are independent and each route through a single generic, promise-based confirmation modal (`#confirm-delete-modal`). After a successful delete the dialog re-fetches `report-info` and re-renders, and the main table refreshes via `fetchReports({ showLoading: false })`.

### Trace digests

Below the **Analysis runs** section, the dialog renders a **Digests** section (`#report-info-digests`) from the `digests[]` array. Each digest card shows the test title, creation date, and the on-disk digest directory (`path.join(runDir, folder)`), with the same copy (button + right-click) and open interactions \u2014 the open link points at the digest's `digest.json`. A per-digest delete button routes through the shared confirmation modal and calls `DELETE /api/digest`, which removes the digest directory (and the now-empty `run-<timestamp>` wrapper) and drops the row. Digests are keyed by the report's stable `uuid`, so they survive renames and folder recycling, and are purged alongside the report on delete/archive (`purgeReportDigests()`) and by `pruneOrphanDigests()` on each scan.

