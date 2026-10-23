# Architecture and Invariants

Read this before changing report discovery, identity, filesystem mutations, or
analysis retention. Development commands and the local validation workflow are in
[Development](docs/development.md); user workflows are in [Documentation](docs/index.md).

## Structure

The application is a local Node/Express server, a synchronous SQLite store, and
vanilla TypeScript pages. There is one server process. No ORM, UI framework, or
background indexing service is required.

| Module | Responsibility |
| --- | --- |
| [server.ts](src/server.ts) | HTTP composition, configuration/presets, report mutation guards and static mounts |
| [runtime.ts](src/runtime.ts) | Cached configuration, artifact-job ownership, report-size cache and SSE subscribers |
| [db.ts](src/db.ts) | SQLite connection, additive migrations and persistence operations |
| [report-catalog.ts](src/report-catalog.ts) | Scan/reconciliation, search and agent discovery |
| [report-storage.ts](src/report-storage.ts) | Instance/path checks, moves with rollback and report-owned cleanup |
| [report-routes.ts](src/report-routes.ts) | Extract, rename, archive, delete and metadata HTTP actions |
| [report-artifacts.ts](src/report-artifacts.ts) | Artifact inventory, ownership, confirmed removal and digest publication |
| [artifact-routes.ts](src/artifact-routes.ts) | Info, size and individual artifact actions |
| [runner-routes.ts](src/runner-routes.ts) | Configuration discovery and local runner lifecycle |
| [runner-command.ts](src/runner-command.ts) | Execution arguments and platform-specific command preparation |
| [playwright-config-loader.ts](src/playwright-config-loader.ts) | Bounded, isolated configuration evaluation |
| [analysis-routes.ts](src/analysis-routes.ts), [digest-routes.ts](src/digest-routes.ts) | Trace-reader CLI orchestration |
| [copilot-analyzer.ts](src/copilot-analyzer.ts), [copilot-evidence.ts](src/copilot-evidence.ts), [copilot-grouper.ts](src/copilot-grouper.ts) | Per-attempt evidence, schema validation and semantic grouping |
| [report-archive.ts](src/report-archive.ts) | Shared embedded report ZIP decoding |
| [report-trends.ts](src/report-trends.ts), [trends-routes.ts](src/trends-routes.ts) | Read-only timing interpretation and exact-attempt resolution |
| [aria-routes.ts](src/aria-routes.ts) | ARIA failure extraction and reviewed snapshot writes |
| [vault-files.ts](src/vault-files.ts), [vault-routes.ts](src/vault-routes.ts) | Note resolution, Markdown rendering and editing |

The dashboard entry [app.ts](src/public/app.ts) owns table wiring and workflow
coordination. Its extracted features are [dashboard-model.ts](src/public/dashboard-model.ts),
[dashboard-confirm.ts](src/public/dashboard-confirm.ts),
[report-info.ts](src/public/report-info.ts), [preferences.ts](src/public/preferences.ts),
and [aria-diff.ts](src/public/aria-diff.ts). [api.ts](src/public/api.ts) centralizes
JSON response checks. These use the existing namespace/script-loading approach;
the order in [index.html](src/public/index.html) is intentional.

The independent Trends page retains its own [model](src/public/trends-model.ts),
[DTO](src/public/trends-types.d.ts), and [view](src/public/trends.ts). The runner
retains its separate [entry](src/public/runner.ts).

## Report identity and reconciliation

- `reports.id` is the folder name and exact displayed origin label, not a stable
  identity. `uuid` identifies one physical report instance.
- `dateCreated` is the original catalog date used for display and UTC filtering.
  `folderBirthtime` is the filesystem marker used for instance checks. Never
  replace the catalog date just because a report moves.
- Rename/archive update ID, path and destination marker together while retaining
  UUID, metadata and catalog date. Cross-drive moves use copy/remove with rollback;
  persistence failures must not silently strand a moved report.
- Only a successful parent-directory listing can establish that a folder is
  absent. An unreadable/incomplete report or an unavailable parent is not a
  deletion: retain the indexed row and artifacts and return scan warnings.
- A verified replacement gets a fresh UUID. Old analysis/digest ownership is
  removed; metadata retains the existing catalog behavior.
- Folder names remain globally unique in the current database schema. A second
  scope using the same basename is reported as `REPORT_NAME_CONFLICT`; it must
  not overwrite the indexed instance. Rename one folder outside the dashboard
  and refresh. There is no automatic schema migration or folder rename.
- Mutations check the indexed path, managed storage and filesystem identity.
  Dashboard requests also carry the UUID captured when the action was selected;
  a stale confirmation must not act on a newly indexed replacement. The optional
  `reportUuid` field preserves compatibility with existing API callers, but
  callers should supply it for protection across catalog refreshes.
- Active analysis/digest instances cannot be moved, deleted or pruned. Storage
  paths cannot change during those jobs. Locks are process-local: do not increase
  the PM2 instance count without redesigning ownership.

`GET /api/reports` scans and reconciles. `GET /api/report-search` and agent search
query existing rows only. Search uses case-insensitive metadata tokens with AND
semantics; dates are separate parameters. Search must not become an implicit
filesystem refresh.

## Persistent data and artifact retention

`app.db` is local to the installed application and uses WAL mode.
`PLAYWRIGHT_REPORTS_DB_PATH` provides isolated storage for tests. Configuration
contains paths, credentials, runner state and Copilot model selections; presets
store named project selections.

Migrations are additive/idempotent. In particular, do not collapse legacy
analysis duplicates or delete their files during startup. New analyses use an
immediate transaction to enforce one retained analysis per UUID; legacy data
requires explicit inventory review and versioned confirmation.

| Artifact | Ownership and lifecycle |
| --- | --- |
| Analysis output | `<currentPath>/tmp/analysis-<uuid>/run-<timestamp>-<uuid>/`; deleting output clears `runDir` but keeps a surviving note mapping |
| Final note | `<vaultPath>/<runName>.md`; archive preserves it at `<archivePath>/analysis/<runName>.md` |
| Grouped fallback | If no final note exists, archive preserves it at `<archivePath>/analysis/grouped-analysis/<runName>.md`; it is not a final vault/agent note |
| Manual digest | `<currentPath>/tmp/digests-<uuid>/<traceKey>/`; deleting one digest leaves siblings intact |

Archive preserves notes before moving reports, then detaches ephemeral output and
purges digests. Delete removes report-owned outputs/mappings. Confirmed missing
or replaced report instances are pruned during scans. Manual digests survive
failure-analysis reruns. Re-digestion stages complete output and rolls back on
publication/persistence failure. Existing single-analysis paths stay valid.

Use `assertOwnedPath` for managed artifacts; reject unsafe/symlink/shared paths
rather than guessing ownership. Inventory and content versions prevent stale
cleanup/editor consent. Cleanup failures must be logged or returned to the user.

Report folder size is separate from Info because recursive scans can be expensive.
Analysis outputs are siblings of report folders; deleting output does not change
report size. Rename/archive/delete/extract/replacement invalidate the size cache.

## Runner lifecycle

A transition reservation covers asynchronous start/stop preparation. Overlapping
transitions return HTTP 409; a valid new run can still replace a running one.
Invalid start requests must not stop an existing run. Late callbacks from an old
child must not clear the new child's state or broadcast its completion.

The selected configuration is captured for the run. Headless overrides are
temporary files beside the selected config and are removed on close/error/stop.
Tree termination errors are surfaced rather than treated as success.

Config evaluation happens in a separate child and returns only project names and
the ARIA path template. Completion waits for child exit, including configs that
leave handles open; bounded termination also applies on failure and timeout.

Execution argv and display strings are separate. Preserve POSIX `shell: false`,
Windows quoting, literal multi-title grep semantics and existing BrowserStack/
Podman argument behavior. See [Running Tests](docs/running-tests.md).

Terminal JS/CSS and licenses are copied from locked xterm dependencies. Core
runner operation does not require a CDN. Optional fonts remain external.

## Parsing and analysis boundaries

Embedded report data supports legacy window assignments, script tags and template
tags. Shared ZIP decoding does not extract files onto disk. Per-attempt timing
comes from detailed test JSON, not just the report summary.

Trends is on-demand and read-only: no timing tables, retained generations or
trace parsing. Requests are bounded to 500 reports, 128 MB per HTML and 64 MB per
JSON entry. Exact attempt array index and retry number are distinct. Source
version and UUID checks prevent links from opening replaced data. Missing,
failed and skipped measurements are not zero-duration passes. Identity review,
repetition balancing and offline export rules are described in
[Managing Reports](docs/reports.md#test-trends).

The reports package owns discovery and vault access; the installed
`playwright-traces-reader` owns trace parsing and its cache. The skill installer
does not initialize the server or database. Agent contracts are in
[Agent API](docs/agent-api.md).

Failure analysis validates selected models before replacing existing output.
Every fenced block under `error.md`'s Error details remains an exact source issue.
Application code validates schema/cardinality/order and renders Markdown; models
explain issues and group them semantically. Preserve bounded concurrency, repair
turns, evidence requests and explicit partial-failure reporting. Full contracts
are in [Failure Analysis](docs/failure-analysis.md).

## ARIA and UI behavior to preserve

Playwright can truncate assertion diffs. Prefer the full `- unexpected value "`
call-log payload when present; do not reconstruct a long snapshot solely from a
truncated diff. Codeframe names and expected-content matching resolve snapshot
paths. Configuration failures and unresolved paths must not create guessed files.
Diff display normalizes CRLF and indentation; applying a fix writes the reviewed
snapshot with the optional deep-equal prefix.

Dashboard selection is transient and scoped to the rendered table. Search draft
and applied filters are separate; untouched date defaults are not fixed filters.
Bulk mutations remain sequential with a single final refresh. The existing
20-report archive policy is frontend-owned, requires explicit prune consent and
uses a minimum prune batch of five; it is not an API/server retention limit.

Destructive confirmations focus Cancel, trap focus, restore focus, and treat
Escape/backdrop as cancellation. Artifact review includes exact keep/delete
paths. Preferences cannot be saved with a runner tab open. Failed saves and scan
warnings must stay visible rather than looking like successful empty results.
