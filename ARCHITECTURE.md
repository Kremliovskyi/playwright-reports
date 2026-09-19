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

- **Database isolation:** `PLAYWRIGHT_REPORTS_DB_PATH` overrides the default database location for disposable fixtures and tests. Normal application startup still uses `app.db`.
- **WAL Mode:** The database is initialized with `journal_mode = WAL` (Write-Ahead Logging) to ensure high concurrent read performance when the frontend dashboard aggressively polls.
- **`config` Table:** Designed to support multiple configurations (e.g., for different teams or projects). The current implementation primarily uses an `id: 'default'` row, but the schema inherently allows scaling to multiple rows containing the physical paths to Current, Archive, and Project root directories, the serialized JSON payload for user-selected Test Runner Options (including relative Playwright and BrowserStack config selections), BrowserStack credentials (`browserstackUsername`, `browserstackAccessKey`), and Copilot settings (`copilotToken`, `copilotModel` for small per-trace analysis, and `copilotBigModel` for run-level grouping). The legacy `browserstackConfig` column remains for schema compatibility; any existing value is migrated once into runner options and then cleared.
- **`presets` Table:** Stores user-created saved project selections. This allows users to instantly recall groups of test suites without manually checking boxes every time.
- **`reports` Table:** Persists metadata for all scanned reports. The primary `id` is the report folder name — it is both the physical folder name on disk and the exact display label shown as "Report Origin" in the dashboard. No transformation is applied; what is on disk is what is shown. Because folder names are frequently recycled (a report is deleted and a new run is later written to the same `playwright-report_2`/`_3` folder), the table also stores a **`uuid`** column that is the _stable per-instance identity_ of a report. `analysis_runs` and `digests` are keyed by this `uuid`, never by the recyclable folder name. Storing report metadata in SQLite allows for persistent user-entered labels that survive filesystem refreshes and folder moves (archiving).
- **`analysis_runs` Table:** Stores the report-to-analysis mapping (`id`, `reportId` = report `uuid`, `runDir`, `runName`, `createdAt`). New writes retain at most one analysis per report: `addAnalysisRun()` checks for an existing row and inserts inside an immediate SQLite transaction. There is no destructive migration or unconditional per-report unique index that would discard legacy duplicates. Existing rows remain available for explicit review.
- **`digests` Table:** Persists saved trace digests (`id`, `reportId` = report `uuid`, `traceKey`, `runDir`, `folder`, `testTitle`, `createdAt`). New digests share `runDir = <currentPath>/tmp/digests-<reportUuid>` and use `folder = traceKey`. A partial unique index on `(reportId, traceKey)` where `traceKey <> ''` supports replacement of the same trace. The additive migration leaves legacy rows with an empty key intact. Digests survive report renames, but their directories and rows are removed on report delete/archive and when their report instance is pruned.

### Read-only search index

The same `reports` table also powers the dashboard's persistent search/filter UI.

- **Searchable fields:** The search layer currently matches only `metadata` and `dateCreated`.
- **Read-only contract:** The dedicated search route does not call `scanDirectory()`, does not upsert report rows, and does not mutate the filesystem. It only queries the already persisted `reports` rows.
- **Why this matters:** Search can stay fast and safe, while normal dashboard load and explicit Refresh remain the only moments when filesystem-to-database sync occurs.

---

## 📊 Report Metadata & Syncing

The application does not use a "dumb" filesystem scan. It implements a differential sync between the disk and the database.

- **Sync During Scan:** Every time `scanDirectory` is called (during dashboard load or refresh), the system builds a list of reports from the disk and immediately `upserts` them into the `reports` table.
- **Active artifact jobs:** A scan retains the existing report record while analysis or digestion is active and skips pruning that busy instance. Archive, delete, rename, extract, and artifact mutations reject conflicting requests; storage paths cannot change during artifact jobs.
- **Metadata Persistence:** User-entered metadata is stored only in the database. During the sync, the system merges the existing DB metadata back into the scanned objects. This ensures that manually added info like 'UAT NA' remains attached to the report even if the server restarts.
- **Renaming Logic:** Users can rename a current report's origin label directly from the dashboard. The `/api/report-rename` endpoint validates the new name (rejects forbidden filesystem characters: `/ \ : * ? " < > |`, null bytes, and `.`/`..`), performs a path-traversal guard by confirming both source and destination resolve within `appConfig.currentPath`, checks that no folder with the new name already exists (conflict guard), then calls `fs.renameSync` to rename the physical folder. The database record's `id` and `reportPath` are updated atomically via `updateReportId()`. The report's `uuid` is **unchanged**, so all `analysis_runs` stay mapped across the rename without any remapping step. Live validation feedback is shown in the UI before any server call is made.
- **Archiving Logic:** When a report is moved to the Archive via `/api/archive`, the backend physically renames the folder, moving it to the archive root with a timestamp suffix to prevent collisions. The database record is then updated to point to the new folder ID and new physical path, preserving the metadata across the move. Because `analysis_runs` are keyed by the stable `uuid` (which does not change on archive), the run mapping is preserved automatically — no `reportId` rewrite is performed. If a matching vault analysis file exists, it is moved from the vault directory to `<archivePath>/analysis/`. Trace `digests` live under the ephemeral `<currentPath>/tmp/` and cannot follow the report into the archive, so they are removed (directories + rows) via `purgeReportDigests()` — the same cleanup as a delete.
- **Deleting Logic:** When a user permanently deletes a report via `/api/delete`, the backend uses `fs.rm` with `{ recursive: true, force: true }` to completely wipe the report from disk, and removes the report's `analysis_runs` by its `uuid`. For each run it also unlinks the mapped vault `.md` file and removes the ephemeral output directory (`runDir`) — the latter guarded by `isWithin(currentPath, runDir)` and wrapped in try/catch so a stray output dir never blocks the delete. The report's `digests` are removed by the same `uuid` via `purgeReportDigests()`, which best-effort deletes each digest's `runDir` (the shared report digest root for new records, guarded by `isWithin(currentPath, runDir)`) before dropping the rows.
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
- **Historical identity migration:** The `uuid` column is added via `ALTER TABLE` with an existence check and backfilled with fresh UUIDs for pre-existing rows. Legacy `analysis_runs` keyed by folder name no longer match any `uuid` and are removed by the orphan prune on first scan (a one-time loss of the old name-based mappings). This predates single-analysis retention; the retention change does not prune, relocate, or rewrite existing UUID-mapped analyses during upgrade.

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
- **Analysis wiring:** After any required replacement consent, `/api/failures` starts one client, authenticates, lists models once, and validates both exact selections before deleting the previous analysis or creating new output. A missing or unavailable selection returns `COPILOT_MODEL_UNAVAILABLE` with `modelRole: "small" | "big"`, leaving the existing analysis intact. The validated client remains alive for all per-trace sessions and the final grouping session.

---

## Agent Discovery Boundary

The dashboard exposes a minimal agent-facing contract for report discovery, but intentionally stops short of trace parsing.

Current endpoints:

- `GET /api/agent/reports/search` queries the persisted `reports` table and returns report descriptors plus an opaque `reportRef`. Each descriptor includes `analysisFiles`, an array of run names whose matching vault `.md` file exists for that report. New run names are `run-<timestamp>-<reportUuid>`; existing names are preserved. Files map through `analysis_runs.runName` (`<runName>.md`), not the recyclable report folder name. The array contract remains unchanged: normally zero or one file, but unresolved legacy records are not hidden. A run's `runDir` is cleared when its output directory is deleted or removed during archive, while the row and analysis-file mapping are retained.
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
- **Date defaults:** Search and Trends calculate UTC creation-date extrema over the complete Current + Archive catalog using `TrendModel.dateBounds`. They do not depend on metadata, a filtered table, or array ordering. Empty catalogs leave dates blank and disabled. Defaults are draft values, not applied filters; untouched full bounds are omitted when submitting Search so future reports are not hidden.
- **Reset behavior:** The explicit `Reset` action clears metadata and the applied filter, repopulates full-catalog date defaults, and restores the cached unfiltered dashboard. Explicit date edits survive reopening an applied Search.
- **Header signal:** When a filter is applied, the Search button remains highlighted so the filtered state is visible even when the dialog is closed.
- **Refresh gating:** Refresh is disabled only while the dialog is open. Once the panel is closed, Refresh is available again even if a filter remains applied.
- **Row actions remain live:** Archive, delete, extract, rename, and metadata editing are still allowed while the dashboard is filtered.

This model reduces layout disruption because the floating panel can be closed while leaving the filtered table view intact.

## On-Demand Test Trends

The dashboard opens [src/public/trends.html](src/public/trends.html) in a new browser tab with `noopener`. This independent page uses [src/report-trends.ts](src/report-trends.ts) for read-only source parsing, [src/public/trends-model.ts](src/public/trends-model.ts) for shared calculations/export projection, and [src/public/trends.ts](src/public/trends.ts) for live and offline rendering. The shared DTO is declared in [src/public/trends-types.d.ts](src/public/trends-types.d.ts). Styling is scoped in [src/public/trends.css](src/public/trends.css), loaded by the standalone page rather than the dashboard. The page entry is copied by [copy-assets.js](copy-assets.js).

### Catalog and generation boundary

- Opening Trends and applying its filters explicitly refresh the catalog through the existing `/api/reports` scan. The new tab owns its catalog and filters; it neither changes dashboard Search state nor disables dashboard Refresh. `/api/report-search` remains a read-only query over persisted catalog rows.
- `ReportInfo` exposes the stable `uuid` in addition to the existing folder ID and path. `POST /api/trends` accepts `reportUuids` and required `testQuery` (trimmed, 1-256 characters). It resolves current records, reads HTML sequentially, and filters leaf titles by literal case-insensitive substring. The schema-2 preview contains report descriptors, matching execution candidates, original source context, attempts, and per-report issues. It does not scan, mutate SQLite, spawn the trace CLI, or create artifacts.
- The reader uses `adm-zip` in memory for the embedded `report.json` and referenced per-file JSON. It recognizes legacy `window.playwrightReportBase64`, script, and template embedding styles. The summary alone lacks per-attempt duration/status, so it cannot replace detailed test JSON. Traces and even a `data/` directory are unnecessary.
- Input is bounded to 500 selected reports, 128 MB per source HTML, and 64 MB per decompressed JSON entry. Unsupported/malformed reports remain explicit issues; valid reports can still contribute. Partial data is never silently presented as a complete selection.
- Search captures data without generating a chart. `TrendModel.review` resolves one explicit project and reversible report/candidate/execution exclusions. Included conflicts and unreadable reports block Generate; no-title-match reports remain gaps, while deliberately excluded reports are removed. `TrendModel.generate` uses exactly that reviewed preview, with no second fetch. Selection edits invalidate chart/export; filter edits also abort and invalidate the preview. New searches reset exclusions, project changes reset candidate exclusions. Closing aborts requests, disconnects observers, and releases both captures. Request sequencing prevents canceled searches from overwriting newer results.

No timing table, durable cache, historical/deleted-report record, export directory, or vault change is introduced. Existing archive/deletion policy is unchanged.

Search and Review are native disclosure sections. Multiple-project matches highlight and focus the required selector before revealing the review table. Readiness is shown next to the disabled/enabled Generate action. Generation collapses both sections, focuses the chart heading, and scrolls only as needed to expose the chart; reopening review preserves captured exclusions. Nonzero summary counts and bounded table scrolling keep large report sets separate from the chart. Date-axis labels are width-checked to avoid collisions at duplicate or nearby timestamps. Offline snapshots omit these live workflow controls.

### Identity and measurements

The live query workflow does not use inferred cross-report identities. Correspondence is established by the query, selected project and manual review, preserving title/file/suite moves for inspection. Within each report, a definition hashes the exact project, slash-normalized full file, full suite path, title, line and column. An execution ID hashes report UUID plus source test ID. Source IDs are retained for links only, not decoded to guess repetition identity.

Multiple records of one definition need valid source locations and unique repeat indices, treating one omitted index as zero when the other indices are explicit and nonzero. Multiple missing indices or duplicate indices are conflicts. Singletons without repeat metadata remain usable. No contiguous-index or complete-shard assumptions are made. Multiple definitions remain conflicts until manually resolved. Removing a definition excludes all its repetitions and retries; record-level exclusion cannot remove individual attempts. Normal merged shard HTML is one report. Copied blobs with duplicate repeat indices remain conflicts, even when Playwright has salted their source test IDs.

Values are milliseconds. Passed duration requires a real `passed` attempt; `outcome: expected` alone is insufficient because it also includes expected failures. Total duration sums attempts once and must agree with report totals. Skipped/not-run values are null; a genuine zero-duration execution remains zero. `repeatEach` entries remain separate, not retries.

Each chart point is an execution, using its first valid attempt time, then report/catalog fallbacks. Selection and history key by execution ID, not report UUID. Timestamp ties preserve source order, including after export ID remapping. Catalog filtering deliberately retains Search's UTC creation-date basis. The latest value is the last chronological execution of the latest included report. Baselines use the median of per-report repetition medians for the first five earlier eligible reports with physical passes and expected/flaky outcomes. The latest report is entirely excluded; repeats cannot overweight a report. Insufficient/zero baselines suppress percentages, and missing/failed latest values never carry forward an older success.

### Source links and sharing

`GET /api/trends/reports/:uuid/test?testId=...&run=...&version=...` resolves a report by UUID through a read-only database lookup. It checks managed-root containment, symlinks, folder birthtime, source-file stability, the SHA-256 of the captured HTML, and test/result existence before redirecting to the current `index.html#?testId=...&run=<result-array-index>`. `Cache-Control: no-store` prevents stale redirects. Existing agent `reportRef` values encode paths and are intentionally not used here. Rename/archive works; missing or changed sources return clear 404/409 responses. This also protects against an in-place HTML rewrite that preserves folder birthtime/UUID.

The download action projects an allowlisted schema-2 dataset for only the generated comparison and retained executions, replacing report and execution identities with snapshot-local IDs and removing test link IDs, source hashes, absolute roots, excluded candidates, and non-timing artifacts. It retains query/project/source context and exclusion counts. It captures the generated data rather than draft fields and cancels delivery if the selection changes during asset loading. It inlines the shared compiled model/viewer and CSS in one HTML Blob. Embedded data is escaped and report strings are rendered as text/escaped HTML. Snapshot mode omits live controls and links, and a restrictive CSP disables network connections and external dependencies. Existing schema-1 downloads retain their own runtime; no import/migration is introduced. Files are user-triggered downloads only; the server retains no export state. Names and user-entered metadata are intentionally included and are not anonymized.

### Verification

[tests/report-trends.test.js](tests/report-trends.test.js) covers parsing, calculations, identity, source guards, safe serialization, and API lifecycle using synthetic embedded reports and an isolated SQLite database. [tests/trends-browser.js](tests/trends-browser.js) is a Playwright CLI scenario for filters, exact links, single-run cases, export, cancellation, and desktop/mobile interaction. It runs against the opt-in `ARTIFACT_TEST_SEED=trends` fixture in [tests/artifact-test-server.cjs](tests/artifact-test-server.cjs), never production reports. The full build/test gate is `npm test`.

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

The execution engine runs Playwright tests on the host machine by default, or inside a temporary Linux container when **Run in Podman** is enabled. Both execution paths stream output live to the dashboard browser window through the same SSE connection.

- **Process Spawning:** Tests are launched via standard Node `child_process.spawn` inside the configured `projectPath`. On macOS and Linux, options remain separate argv entries with `shell: false`; multiword grep values therefore require no literal quote characters. Command logging formats those arguments separately for readability.
- **Windows Polish:** Native Windows runs execute `npx.cmd` with `shell: true` and retain the `cmd.exe` quoting required around multiword grep values. POSIX platforms and Podman launches on every platform use `shell: false`.
- **Server-Sent Events (SSE):** The frontend opens an EventSource connection to `/api/logs`. The backend captures stdout/stderr buffers from the spawn output and pushes them down instantly. The UI layer (`xterm.js`) renders these buffers preserving their original ANSI color codes for a perfect native terminal replica.
- **Zombie Process Protection:** Standard `child.kill()` fails to wipe out deep nested browser threads spawned by Playwright, leaving zombie Chromium processes hanging in the background. We imported `tree-kill` to aggressively trace the process PID tree and issue a clean `SIGKILL` when the user clicks 'Stop Tests'.

### Config Discovery

The `src/runner-configs.ts` helper uses `glob` within `projectPath` to discover `**/*playwright*.config.{ts,js,mts,mjs,cts,cjs}` and `**/*browserstack*.{yml,yaml}` while ignoring `node_modules`, `test-results`, and temporary Headless overrides. Results are sorted by path depth, basename length, and lexical order so a conventional root `playwright.config.ts` is preferred. The runner persists selected paths relative to `projectPath`; the server accepts a selection only when it is present in the current discovered set and resolves inside the project root.

Each Playwright config is evaluated in a short-lived child process. The child loads one config with Jiti and returns only the serializable fields the dashboard needs: project names and the ARIA snapshot path template. This prevents different projects or Playwright versions from sharing module and process-global state in the long-running dashboard server.

### Run Tests Button Guard

The **Run Tests** button in the main dashboard header is disabled when `projectPath` is not configured in Preferences. This prevents launching the runner page for a project that cannot execute.

- **State check on load:** `app.ts` fetches `GET /api/config` immediately after the page loads and calls `updateRunTestsBtnForProjectPath(projectPath)`. If the value is empty the button is disabled and its opacity reduced to 0.7.
- **Hover tooltip:** The button is wrapped in a `div.run-tests-wrapper`. When disabled, a `.run-tests-tooltip.show-tooltip` element is revealed on hover via CSS, showing _"Configure in Preferences to enable: Playwright Project Path"_ — the same visual pattern used by the BrowserStack checkbox in the runner page.
- **Preferences guard:** Saving Preferences sends a fresh runner-state ping. If any runner tab responds, the dashboard asks the user to close it and does not save. This prevents an open runner from retaining options for a project that is being replaced.
- **Reload after save:** A successful Preferences save reloads the dashboard so all paths, report data, status controls, and runner configuration start from the persisted settings.
- **Two independent disable reasons:** The button also disables while a Runner tab is already open (governed by `BroadcastChannel('runner_state')`). The two states are tracked by separate `isProjectPathMissing` and `isRunnerOpen` flags so closing the runner tab does not re-enable the button if the project path is still missing.

### Browser Mode Overrides

Headed and Headless are mutually exclusive runner options. With neither selected, the target project's `use.headless` setting is preserved. Headed uses Playwright's `--headed` CLI override. Because `playwright test` has no corresponding `--headless` option, Headless creates a temporary config beside the target config that preserves the base configuration and sets `use.headless: true` at both the top level and for every project. The server passes that file through `--config` and removes it after completion, stop, or process-start failure.

### BrowserStack Cloud Execution

When the user enables the BrowserStack checkbox in the runner, the spawned command changes from `npx playwright test ...` to `npx browserstack-node-sdk playwright test ...`. The SDK wraps the local Playwright execution and tunnels it through BrowserStack's infrastructure.

- **Credential Injection:** `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` are injected into the child process `env` from the persisted config (never exposed in the command line or frontend source).
- **Config Argument:** The selected discovered relative path is appended as `--browserstack.config=<path>` (for example, `configs/browserstack.falcons.yml`).
- **Incompatible Options:** BrowserStack cloud runs do not support local-only Playwright flags. When the checkbox is active, the frontend disables Headed, Headless, UI Mode, Debug, Update Snapshots, and Run in Podman toggles, and locks the Workers and Repeat inputs. Visual cues (`.bs-disabled` class, tooltip) clearly communicate why these options are unavailable.
- **State Restoration:** When BrowserStack is unchecked, previously selected options are restored to their prior state. The frontend remembers the pre-BrowserStack values so the user does not lose their local configuration.

### Podman Container Execution

The runner persists `runnerOptions.usePodman` (default `false`) through the existing config API and sends `usePodman` to `POST /api/run-tests`. The checkbox sits beside **Update Snapshots**; its info button reuses the runner's scrollable dialog with keyboard dismissal and focus restoration. User-facing setup instructions live in [Running Tests](docs/running-tests.md#run-in-podman).

- **Executable resolution:** `resolvePodmanExecutable()` in `src/runner-command.ts` uses `podman` on POSIX. On Windows it searches PATH first, then the standard per-user `%LOCALAPPDATA%/Programs/Podman` and Program Files install locations. This handles an installed Podman executable missing from a stale server PATH.
- **Preflight and image pinning:** `resolvePodmanImage()` reads `npm-shrinkwrap.json` before `package-lock.json`, resolves the exact stable Playwright version, and selects `mcr.microsoft.com/playwright:v<version>-noble`. The server checks `podman info --format json` and `podman image inspect` before spawning. Missing prerequisites return actionable HTTP 400 errors. The runner neither starts the Podman machine nor pulls images; Windows/macOS users must start the machine first and prepare the matching image.
- **Command boundary:** `buildPodmanArgs()` constructs `podman run --rm --pull=never --init --ipc=host` with a unique `pw-reports-<uuid>` container name. Podman is spawned without a host shell, including on Windows. Playwright arguments remain separate argv entries and reach the fixed container script through `"$@"`; Windows grep quoting is not applied, and config paths are normalized to forward slashes.
- **Dependency isolation:** The project is mounted read/write at `/work` with `:Z`, while an anonymous volume masks `/work/node_modules`. The container runs `npm ci --include=dev && exec npx playwright test "$@"`. This installs Linux dependencies afresh without using or modifying host dependencies. The lockfile must match `package.json`, registry access is required, and the official image provides browser binaries rather than the project's npm packages. Config discovery still runs on the host, so host-side project dependencies remain necessary.
- **Headless enforcement:** Podman reuses the temporary Headless config override regardless of the incoming `headless` flag. The frontend disables Headed, Headless, UI Mode, and Debug while Podman is selected; the server rejects Podman requests combined with BrowserStack or interactive flags. Snapshot updates remain available.
- **Environment and output:** Only explicitly entered environment variables and runner defaults are forwarded, not the server's full environment. Variable names are validated and passed with `--env NAME`, keeping their values out of command arguments. Defaults include `FORCE_COLOR=1`, `PLAYWRIGHT_HTML_OPEN=never`, and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Reports and snapshots written inside the mounted project persist on the host; screenshots use Linux baselines. External host paths are not mounted, and host services should be addressed through `host.containers.internal` rather than container `localhost`.
- **Lifecycle and Stop:** The server tracks the attached child process, temporary config, and container name. Normal completion uses Podman's `--rm` to remove the container and anonymous dependency volume. Stop calls `podman rm --force --ignore <name>` before terminating the remaining local process tree; container-removal failures are surfaced to the caller. Temporary config cleanup runs on process completion, Stop, and startup failure.
- **Trust boundary:** This mode is intended for trusted tests and sites. The official image runs as root with Chromium sandboxing disabled, and the read/write project mount allows test code to modify host project files. It is not a sandbox for untrusted code.

---

## 🔍 Data Extraction Strategy

Playwright generates static HTML reports. Instead of trying to parse pure HTML tables to find test results, this application extracts the raw JSON data that Playwright embeds inside the `index.html` report.

1. **Base64 Zip Extraction:** Modern Playwright versions append a `<script id="playwrightReportBase64">` tag containing a Base64-encoded ZIP file at the very end of the `.html` file.
2. **In-Memory Unzipping:** The backend uses `adm-zip` to decode this Base64 string and unzip the contents completely in-memory.
3. **JSON Parsing:** Inside the zip, Playwright stores a `report.json` and individual `data/xxxx.json` files for each test. We parse these directly to obtain 100% accurate test failures, metrics, and network traces.

---

## 🧪 Failure Analysis (`playwright-traces-reader` `failures`)

The **Analyze Failures** overflow action (current reports only) runs the installed `@andrii_kremlovskyi/playwright-traces-reader` CLI to digest a report's failing tests into self-contained per-failure folders for AI agents.

- **Endpoint:** `POST /api/failures { reportPath, replaceRunId?, analysisVersion? }`. The first request normally sends only `reportPath`; replacement fields are sent only after confirmation.
- **CLI Resolution:** The server resolves the CLI entry via `require.resolve('@andrii_kremlovskyi/playwright-traces-reader')` and joins `cli.js` next to the resolved package main, so it always runs the version installed in `node_modules` (no global dependency).
- **Execution:** After strict Copilot model validation succeeds, it spawns `node cli.js failures <reportRoot> <outputDir> --format json` with `cwd` set to `currentPath`. The request stays open for the full duration — on machines where antivirus scanning or large reports make the command slow, the row progress overlay keeps spinning until the manifest returns.
- **Request deduplication:** The client tracks active report paths and ignores repeated same-page clicks. The server resolves the registered report and keys `activeFailureAnalyses` by its stable `uuid`, returning HTTP 409 with `FAILURE_ANALYSIS_IN_PROGRESS` when that report is already active. The key is released in `finally`, including CLI, Copilot, grouping, and error exits. This lock is process-local and matches the single PM2 instance in `ecosystem.config.js`; it is not a cross-process artifact lock. The reader's trace-cache publication remains a separate concern.
- **Trace ZIP cache:** The reader hashes ZIP bytes and extracts into `<os.tmpdir>/playwright-traces-reader/trace-cache/<archive-digest>/<trace-name>`. Same-process requests share pending extraction work; cross-process callers stage independently and atomically publish the completed trace directory. A Windows `EPERM` is accepted only when the completed destination exists; otherwise publication is retried with exponential backoff. Staging cleanup also retries transient filesystem locks. Before each trace-reading command, a process lease and maintenance lock allow completed entries unused for 24 hours and staging entries older than 1 hour to be pruned only when no other reader is active. The defaults are configurable through `PWTR_CACHE_MAX_AGE_HOURS` and `PWTR_CACHE_STAGING_MAX_AGE_HOURS`; `0` disables the corresponding age policy. There is no size cap. The entire cache may be removed only while no reader command or library consumer is running.
- **Output Location:** New analyses use `<currentPath>/tmp/analysis-<reportUuid>/run-<timestamp>-<reportUuid>/`. The CLI initially creates its timestamped run folder; the server validates the manifest, adds the report UUID to the run basename, and updates `index.json` before persisting the row. The UUID suffix prevents cross-report collisions in the shared vault filename namespace. Each run contains per-failure folders and the manifest; the parent retains only the current run. Existing single-analysis paths are not migrated.
- **AI Evidence Extraction (Copilot SDK):** After the CLI digest completes, the dashboard runs per-trace extraction (`src/copilot-analyzer.ts` → `analyzeRun`) over each **analyzable** failure (Before Hooks and `outcome: "skipped"` entries are excluded). `error.md` is the exclusive issue source: every fenced block under `# Error details` produces exactly one ordered issue. The selected small model receives full `error.md`, sanitized failure metadata, and optional network errors, then returns a minimal explanation for each block: summary, operation, expected and observed behavior, directly supported likely cause, relevant signals, confidence, and unknowns. Application code validates schema, cardinality, and block order, attaches each exact source block, and writes schema-v4 **`evidence.json`**. Invalid output receives one correction turn with the precise validation error; a second invalid response retains every source block with a low-confidence fallback and warning. **`ai-analysis.md`** is rendered deterministically from the same record without a Markdown-generation model call.
- **Concurrent analysis (3-way pool):** The per-trace analysis runs through a bounded worker pool of `ANALYSIS_CONCURRENCY = 3` (hardcoded in `copilot-analyzer.ts`). Each folder reads only its own `failure.json`, `error.md`, and network file, creates its own Copilot session, and writes only its own `evidence.json` and `ai-analysis.md`. One shared validated `CopilotClient` hosts the isolated sessions. A synchronous cursor and counters coordinate the I/O-bound workers without locks, and one failed extraction never aborts the others.
- **Problem Grouping:** Once all workers finish, `src/copilot-grouper.ts` creates one tool-free session using `copilotBigModel`, high reasoning effort, and the default context tier. The initial prompt includes manifest context plus each issue's exact primary error line and bounded small-model explanation; application code supplies no failure-family, state, lifecycle, causal, resolution, or incident keys and does not force semantic merges or splits. The big model returns a complete provisional grouping and may request one bounded evidence round for plausible matches that require selected error-block, final-page, test-source, or network snippets. Current-run IDs, section names, per-request limits, total budgets, and path containment are enforced before one follow-up in the same session; no arbitrary file tool or second retrieval round exists. Final validation is structural only: every issue ID must appear exactly once. Missing, unknown, or duplicate IDs receive one focused repair turn. If repair fails, sanitization removes invalid references and places omitted issues under `Unclassified - invalid grouping references` without changing valid semantic assignments. Each high-reasoning grouping, evidence, or repair request has a 10-minute timeout. No previous-run, knowledge-base, ADO, defect, or work-item data enters grouping. The completion dialog reports evidence volume, repair results, request/prompt/response sizes, token/context usage, finish reason, and truncation or compaction events.
- **Response:** The server returns the manifest, per-trace summary, and either grouped-report metadata or a non-fatal `groupingError`. The completion dialog links both `index.json` and `grouped-analysis.md` when grouping succeeds. Partial AI or grouping failures retain the new run and display warnings rather than unconditional success.
- **Lifecycle:** `grouped-analysis.md` lives inside the run directory and appears in the completion and Report Info dialogs. It is ephemeral and is deleted with the output directory or during archive cleanup; it is separate from the durable vault Analysis file.
- **Boundary Note:** This is one place `playwright-reports` shells out to the parser CLI directly (for a one-click convenience action). The agent discovery API still does not parse traces itself — see the Agent Discovery Boundary section.

### Retention and confirmation

`src/report-artifacts.ts` owns read-only inventory, path ownership checks, confirmed analysis removal, and digest relocation/publication. The server orchestrates these helpers with SQLite updates; filesystem changes and database writes are not one atomic transaction.

- **Preserve on upgrade:** One existing output directory and its saved final vault note are a healthy analysis, including on archived reports. Their contents, paths, timestamps, associations, and URLs remain unchanged. Per-attempt files and `grouped-analysis.md` inside the output directory are components of that analysis, not duplicate final analyses. There is no automatic history cleanup.
- **Read-only inventory:** `analysisInventory()` inspects mapped outputs and notes in both vault locations. It returns entries, issues, candidate keep/remove paths, and an opaque version derived from records, file metadata, and selected artifact contents. Distinct output or note paths determine duplication; multiple rows alone can instead require manual review. This is not a recursive filesystem discovery or full-tree checksum.
- **Confirmed rerun:** An existing single record yields HTTP 409 `ANALYSIS_REPLACEMENT_REQUIRED`, including the current run ID and inventory. **Delete & Analyze** resubmits `replaceRunId` and `analysisVersion`. After Copilot preflight, the server rechecks the report identity, ownership, and inventory, removes the previous output and mapped note, deletes its row, then starts generation. Cancel sends no replacement request. Once removal occurs, a failed new run cannot restore the old analysis; manual digests are unaffected. Unpersisted new output is cleaned on failure.
- **Legacy duplicate review:** `ANALYSIS_REVIEW_REQUIRED` directs the user to Report Info. Nothing is deleted until a keeper is explicitly selected and the exact **KEEP** and **DELETE** paths are confirmed through `POST /api/analysis/consolidate { reportId, keepRunId, version }`. No newest-wins default is used. Cleanup cannot remove the only remaining output directory or the only remaining final note. Complementary records, repeated references without distinct duplicates, and unsafe or ambiguous paths remain available for review rather than being silently merged or discarded.
- **Stale consent and ownership:** Removal recomputes the inventory and rejects changed consent with `ANALYSIS_CHANGED`. Managed-path checks reject paths outside configured roots and symlink traversal within those roots; cleanup also rejects overlap with retained artifacts or another report's analysis. Unknown children in a managed analysis parent block generation instead of being swept away.
- **Concurrent mutations:** `reportIsBusy()` combines analysis UUIDs and digest job keys. Conflicting report/artifact mutations and duplicate consolidation return HTTP 409; storage path changes are blocked while jobs run. These guards protect requests within one server process, not external filesystem changes or other server instances.

---

## 🔍 Selective Trace Digestion (`playwright-traces-reader` `digest`)

Digesting a full test suite with 300–600 tests bulk-style is extremely resource-intensive and produces massive filesystem clutter. To solve this, the dashboard provides a **Selective Trace Digestion** flow:

### 1. Test Discovery (`POST /api/report-tests`)

- **Request payload:** `{ reportPath: string }`
- **Mechanism:** The server runs `playwright-traces-reader find-traces <reportRootPath> ""` to list all tests and trace locations in the report without extracting any traces.
- **UI Presentation:** The frontend renders these tests in a scrollable, searchable list. Searching by test title is performed instantly in-browser to avoid server round-trips.

### 2. On-Demand Digestion (`POST /api/digest-test`)

- **Request payload:** `{ reportPath, tracePath, replaceDigestVersion? }`. The source must belong to the registered report's `data/` directory.
- **Trace identity:** `traceIdentity()` hashes the normalized path relative to `data/` with SHA-256, removing a trailing `.zip` so an archive and its extracted directory share a key. Titles do not identify digests; distinct trace paths for projects, retries, or same-title tests remain separate. Active requests are deduplicated by `<reportUuid>:<traceKey>` with HTTP 409 `DIGEST_IN_PROGRESS`.
- **Execution:** Spawns `node cli.js digest <tracePath> <stagingDir> --report <reportRootPath> --format json`. Staging is a `.staging-*` child of the report's shared digest root. The server validates the returned manifest, source containment, and `digest.json` trace identity before publication.
- **Output:** Published digests live at `<currentPath>/tmp/digests-<reportUuid>/<traceKey>/digest.json` with their companion files. The temporary CLI timestamp/title wrapper is removed after publication. All subsequent digests for the report use this one root; re-digesting the same trace replaces its child without affecting siblings.
- **Persistence and rollback:** `publishDigest()` backs up an existing child, publishes the complete replacement directory, and calls `replaceDigests()` to transactionally update the database mapping. A publication or persistence failure restores the previous child. A leftover backup can be recovered on a later attempt. Staging is cleaned in `finally`; this is rollback support, not a cross-filesystem/database atomicity guarantee. The response rewrites manifest paths and `digestUrl` to the published location.
- **Legacy relocation:** No startup migration removes old digests. On the next digest request, existing digest folders are moved intact beneath the shared root as `legacy-<digestId>` children, with their mappings updated. Relocation rolls back on persistence failure and can resume an interrupted mapping update; missing or conflicting locations require review. Analysis outputs and vault notes are not moved by this process.
- **Duplicate consent:** Multiple legacy digests for the requested trace return HTTP 409 `DIGEST_REPLACEMENT_REQUIRED` with exact paths and a version. Only a confirmed `replaceDigestVersion` permits replacement, and superseded copies are removed after successful publication. Untracked canonical output is not silently overwritten.
- **Lifecycle:** Digests remain discoverable in Report Info. Deleting one removes only its child and row, with best-effort removal of an empty parent. Report delete/archive removes the report's digests; orphan pruning removes stale mappings.
- **Token Efficiency & Workflows:** The digested outputs (step tree + companion console & network NDJSONs) are designed for AI agents to reason about test execution without consuming excessive tokens. Providing a structured chronological step tree and parsed HTTP exchanges simplifies complex automation workflows, such as parsing trace API calls to automatically scaffold a `k6` load test from E2E test runs.

---

## 🛡️ Playwright Config Resolution (`jiti`)

To reliably know where a given test project's aria snapshots are stored, and to execute tests accurately, **the dashboard requires Playwright to be installed in the underlying project workspace.**

Furthermore, the backend needs to parse the Playwright config selected in the runner.

- **The Problem:** Node cannot natively `require()` a TypeScript file without compilation.
- **The Solution:** We use `jiti` to dynamically transpile and import the config on the fly. This is a crucial internal dependency for resolving workspace variables.
- **Aria Path Template:** We specifically read `config.expect?.toMatchAriaSnapshot?.pathTemplate` to determine the exact folder structure Playwright expects for `.yml` snapshot files.

---

## 🚨 Critical Edge Case: Aria Snapshot Parsing

The logic for extracting the "New Snapshot" from a failed `toMatchAriaSnapshot` assertion is **deliberately complex**. Do not attempt to "simplify" it using naive unified diff parsing (e.g., just grabbing `+` lines).

### The "Truncated Diff" Problem

When an aria snapshot fails, Playwright's terminal output (and thus the `error.message` in the JSON) presents a unified diff (using `@@ -x,y +a,b @@` headers).

**If you try to build the new file purely from this diff, it will fail.** Playwright deliberately _omits_ (truncates) matching middle lines of long snapshots in the console output to save space. Reconstructing a file from a truncated diff results in massive chunks of missing DOM lines.

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

When a test has _multiple_ `toMatchAriaSnapshot` assertions, identifying _which_ file actually failed is tricky.

1. **Codeframe Extraction:** The backend examines the `error.codeframe` block to find the exact line that failed (marked with `^ Error:` or `>`). It specifically searches the surrounding 5 lines for `name: 'filename.yml'`.
2. **Content Fallback:** If the codeframe is missing or ambiguous, the system parses the `- Expected` lines from the error log and manually scans the test's snapshots directory (`src/test-data/aria-snapshots/...`). It reads every `.yml` file and returns the one whose text content exactly matches the expected block.

---

## 💅 Frontend "Deep Equal" UI & Diff View

When developers fix aria snapshots, it's essential to understand exactly what changed and frequently they want to enforce `deep-equal` checking across the entire body.

- **Diff View:** Instead of presenting users a raw editable textarea containing the new snapshot, the frontend computes a live Longest Common Subsequence (LCS) diff between the expected snapshot on disk and the new snapshot in the error. Removed lines are highlighted green, and added lines are highlighted red to exactly match the terminal and Playwright HTML report conventions.
- **Deep Equal Checkbox:** The Preview UI Modal includes a "Deep Equal" checkbox in the footer. It is `checked` by default.
- **Dynamic Processing:** The `app.ts` logic detects this checkbox and dynamically prepends `- /children: deep-equal\n` to the top of the diff output. It executes this _without_ triggering diff highlighting (so it appears as regular text), ensuring the user can apply the validation globally with a single click before submitting to the `/api/fix-aria-snapshot` endpoint.
- **Indentation Normalization:** The expected snapshot (read from the `.yml` file on disk) uses 4-space YAML indentation (as enforced by the project's snapshot rules), while the new snapshot extracted from Playwright's error output always uses 2-space indentation. Before the LCS diff runs, both strings are passed through `normalizeIndent()` which detects the minimum indent unit and normalises everything to 2-space. This ensures virtually all unchanged lines match exactly and the diff highlights only genuine content differences. **The Apply Fix path is not affected** — the 2-space string from Playwright's error output is saved directly, which is what Playwright itself expects when re-running tests.
- **CRLF Normalization:** On Windows, Git's default `core.autocrlf=true` checks out `.yml` snapshot files with `\r\n` line endings. The new snapshot extracted from Playwright's error log is always LF-only (each extracted line is already stripped of `\r`). Without normalization, `computeDiff` splits by `\n` and compares e.g. `"  - radio \"Passport\"\r"` vs `"  - radio \"Passport\""` — the LCS finds zero matches, causing every line to show as removed/added. To prevent this, `fs.readFileSync` in `server.ts` applies `.replace(/\r\n/g, '\n').replace(/\r/g, '\n')` immediately after reading the expected snapshot from disk. As a belt-and-suspenders measure, `normalizeIndent()` and `computeDiff()` in `app.ts` also normalize their inputs before splitting, making the diff immune to CRLF regardless of data source.

---

## 📓 Vault Integration (Markdown Analysis Files)

The dashboard integrates with an Obsidian-style vault directory for storing per-report analysis notes as Markdown files.

### Configuration

- **Vault Path:** Configured in Preferences alongside other paths. Stored in the `config` table as `vaultPath`. The DB migration adds the column via `ALTER TABLE` with an existence check.
- **File Matching:** Report Info and agent discovery resolve `<runName>.md` through the report's `analysis_runs` mappings, not its origin label. New run names include the report UUID; existing filenames remain valid without renaming.

### Server-Side Rendering

- **markdown-it:** Markdown files are rendered server-side using `markdown-it` with `html: true`, `linkify: true`, and `typographer: true`.
- **Vault Page:** `GET /vault/:filename` returns a full standalone HTML page with dark theme, rendered markdown, and an inline edit/save UI.
- **Edit Mode:** The page includes a `<textarea>` pre-filled with the raw markdown. Save writes back to disk via `PUT /api/vault/:filename`. The textarea uses `min-height: 80vh` for comfortable editing.
- **Stale editor protection:** Rendered vault and grouped-analysis pages send an `expectedVersion` content hash on save. A changed or removed file is rejected instead of overwritten or recreated by a stale editor. Saves for a mapped report with an active artifact job are also blocked. The precondition is optional for API compatibility; ordinary new-note creation without it remains supported.

### API Routes

| Route                        | Method | Purpose                                                          |
| ---------------------------- | ------ | ---------------------------------------------------------------- |
| `/api/vault/list`            | GET    | Lists `.md` files in the vault directory with modification times |
| `/api/vault/:filename/raw`   | GET    | Returns raw markdown as `text/markdown`                          |
| `/api/vault/:filename`       | PUT    | Writes `req.body.content` back to disk                           |
| `/vault/:filename`           | GET    | Renders full HTML page with markdown-it                          |
| `/api/agent/vault/list`      | GET    | Agent-facing vault file listing                                  |
| `/api/agent/vault/:filename` | GET    | Agent-facing raw file content (used by `vault-read` CLI)         |

### Security

- **Path Traversal Guard:** `resolveVaultFile()` applies `path.basename()` then `path.resolve()` and verifies the result starts with the configured vault directory. This prevents directory traversal attacks via crafted filenames.

### Archive-Aware File Relocation

Vault `.md` files use the persisted analysis `runName`, not the report origin label. Archiving renames the report folder but leaves its UUID and run names unchanged. The archive endpoint moves each mapped file from `<vaultPath>/<runName>.md` to `<archivePath>/analysis/<runName>.md`, creating `analysis/` if needed. The move includes an EXDEV cross-drive fallback (copy + delete) and is wrapped in a try/catch, so a vault file failure does not block archive itself. This is an explicit archive lifecycle action, not an upgrade migration.

Archiving also removes each run's ephemeral output directory (`runDir`) from disk and clears its `runDir` reference via `clearAnalysisRunDir()`, while keeping the row so the archived report still maps to its (now relocated) analysis file. The report-size cache is invalidated for the archived report id.

**Clear is unconditional.** The physical `fs.rmSync(runDir)` and the DB `clearAnalysisRunDir()` are deliberately split: `clearAnalysisRunDir()` runs _outside_ the `try/catch` that wraps the removal, so the `runDir` reference is detached even when the physical delete throws (a common Windows scenario — a locked file, partial deletion, or antivirus hold). If the clear were left inside the same `try` after `rmSync`, a throw would skip it, leaving a stale `runDir` that points at a now-gone directory. That stale row surfaces as a misleading `(missing on disk)` badge in the report's Info dialog even though the output dir was intentionally dropped on archive.

### Dual-Location Vault Resolution

`resolveVaultFile()` checks both `<vaultPath>` (for current reports) and `<archivePath>/analysis/` (for archived reports) when resolving a filename. The vault list endpoints (`/api/vault/list` and `/api/agent/vault/list`) merge files from both locations. The save endpoint (`PUT /api/vault/:filename`) resolves existing files from either location before writing; new files default to `vaultPath`.

---

## Row Actions: Inline Buttons + Overflow Menu

Report row actions use a three-tier pattern: inline action buttons for frequently used operations, a primary "View Report →" link, and a "⋯" overflow trigger for less common actions.

### Inline Buttons

- **Info** (always shown): Opens the Report Info dialog for that report (folder size, Analysis, and Digests). Rendered as a compact `btn-inline-action` button; the label shows a persisted-run count suffix, normally `Info (1)`. Larger legacy counts remain visible until reviewed.
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

The per-row **Info** button (always visible) opens a modal showing the report's on-disk footprint, **Analysis**, and **Digests**. A healthy report has zero or one analysis card. Legacy records remain visible, with a **Review analysis data** action when the inventory requires attention; the UI never hides duplicates by slicing the result array.

### Two-artifact lifecycle model

An `analysis_runs` row represents the **report ↔ analysis-file** mapping. Its `reportId` holds the report's stable `uuid`, so it survives rename/archive but is never inherited by a new instance that recycles the folder name. The `runDir` is a _detachable reference_ to the failure-analysis output directory (new runs use `<currentPath>/tmp/analysis-<reportUuid>/run-<timestamp>-<reportUuid>/`; legacy paths remain valid). One output directory plus its vault note is one analysis, with decoupled artifact lifecycles:

- **Output directory** (`runDir`): managed, reproducible output, not an unowned scratch directory or an automatic age-based cleanup target. Deleting it removes the directory and **clears** `runDir` via `clearAnalysisRunDir()`, keeping the row so the analysis file stays mapped. Report delete/archive also removes the output, guarded by `isWithin(currentPath, runDir)`. A separately confirmed rerun intentionally removes both artifacts before generating their replacement.
- **Analysis file** (`<runName>.md`, resolved via `resolveVaultFile()`): long-lived. On archive it is moved into `<archivePath>/analysis/`. Deleting it removes the `.md` from disk; the row is pruned (`deleteAnalysisRun()`) only when the output dir reference is already gone.

Because the report folder (`<currentPath>/<reportId>`) is a **sibling** of `tmp/`, deleting output dirs or analysis files never changes the report folder size.

### Endpoints

| Route                             | Method | Purpose                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/report-info?reportId=`      | GET    | Returns `folderExists`, the existing `runs[]` and `digests[]` contracts, and read-only `analysisInventory` (`version`, `needsReview`, `duplicated`, `entries`, `choices`, `issues`). Includes detached/missing artifacts and legacy records. Inspects mapped files but does not recursively scan the report or mutate data. |
| `/api/analysis/consolidate`       | POST   | `{ reportId, keepRunId, version }` validates explicit duplicate-cleanup consent, preserves the selected analysis, removes only approved duplicate artifacts, and deletes superseded rows.                                                                                                                                   |
| `/api/report-size?reportId=`      | GET    | Recursive byte size of the report folder, **cached** in an in-memory `Map` after first calculation. Pass `?refresh=1` to recompute.                                                                                                                                                                                         |
| `/api/analysis-run/output-dir`    | DELETE | `{ reportId, runName }` — validates the dir is within `currentPath`, removes it, clears the `runDir` reference.                                                                                                                                                                                                             |
| `/api/analysis-run/analysis-file` | DELETE | `{ reportId, runName }` — validates the file is within `vaultPath`/`archivePath/analysis`, unlinks it, prunes the row if the output dir is already gone.                                                                                                                                                                    |
| `/api/digest`                     | DELETE | `{ reportId, digestId }` validates the digest directory is within `currentPath`, removes that child and its row, and attempts to remove its parent only if empty. Sibling digests remain intact.                                                                                                                            |

### Size calculation & caching

Size is split from `report-info` so the **Analysis** section renders without waiting for a potentially multi-GB recursive scan. The size loads asynchronously and fills in when ready. The result is cached both server-side (`reportSizeCache`) and client-side (`reportSizeCache` Map). The server cache is invalidated only where the report folder itself is mutated: **extract** (adds unzipped data), **archive**, **rename**, and **delete**. Run/output-dir deletions do not invalidate it.

### Path interactions

Each path row supports three interactions: a visible **copy** button, **right-click → Copy path** (reusing the shared `showAnalysisContextMenu` context menu), and **open** links (the failures `index.json` for an output dir, the rendered `.md` vault page for an analysis file). Missing artifacts show a `(missing on disk)` badge or a muted empty state (`— removed` / `No analysis file`).

**Archived reports never show `(missing on disk)` for an output dir.** An archived report's ephemeral output dir is always intentionally gone (it cannot follow the report into the archive), so any leftover `runDir` is stale by definition. When `/api/report-info` builds the `runs[]` for an archived report (`reportPath` under `/reports/archive/`), it presents a non-existent `runDir` as removed — blanking the path so the row renders the muted `— removed` empty state instead of the alarming `(missing on disk)` badge. This also self-heals rows left stale by older builds that skipped the clear on a failed `rmSync`.

### Delete confirmation

Output-dir and analysis-file deletes are independent and each route through a single generic, promise-based confirmation modal (`#confirm-delete-modal`). After a successful delete the dialog re-fetches `report-info` and re-renders, and the main table refreshes via `fetchReports({ showLoading: false })`.

The same modal supports **Delete & Analyze** and duplicate review with an explicit keeper selector and exact keep/delete paths. It uses `role="alertdialog"`, initially focuses Cancel, traps keyboard focus, restores focus on close, and treats Escape or backdrop clicks as cancellation. Unsafe keeper choices are disabled, and concurrent prompts cannot replace an unresolved confirmation.

### Trace digests

Below **Analysis**, the **Digests** section (`#report-info-digests`) renders the `digests[]` array. Each card shows the test title, creation date, and digest directory (`path.join(runDir, folder)`), with copy and open interactions; the open link points at `digest.json`. New cards share the report digest root but have distinct trace-key children. Per-digest deletion removes only that child and row; report delete/archive removes all its digests via `purgeReportDigests()`. UUID ownership preserves digests across rename without attaching them to a new report that recycles the folder name.

### Artifact lifecycle verification

[tests/report-artifacts.test.js](tests/report-artifacts.test.js) covers current/archived preservation, explicit duplicate cleanup, stale consent, unsafe/shared paths, SQLite migration and write guards, digest replacement/rollback, installed-reader compatibility, and API lifecycle/concurrency flows. [tests/artifact-test-server.cjs](tests/artifact-test-server.cjs) supplies disposable report/config/database fixtures and stubbed analysis jobs. [tests/artifact-browser.js](tests/artifact-browser.js) exercises confirmation cancellation, replacement, keeper selection, and desktop/mobile dialog layout through `playwright-cli`.

Run `npm run build && node --test tests/report-artifacts.test.js` from this repository for the focused suite, or `npm test` for the full suite. Fixtures live beneath this repository's `tests/` and use `PLAYWRIGHT_REPORTS_DB_PATH`; validation must not use a working report database, live report folders, or tests from the configured external project.
