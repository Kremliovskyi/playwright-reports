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
- **`reports` Table:** Persists metadata for all scanned reports. It uses the report folder name as the primary `id`. Storing report metadata in SQLite allows for persistent user-entered labels that survive filesystem refreshes and folder moves (archiving).

---

## 📊 Report Metadata & Syncing

The application does not use a "dumb" filesystem scan. It implements a differential sync between the disk and the database.

- **Sync During Scan:** Every time `scanDirectory` is called (during dashboard load or refresh), the system builds a list of reports from the disk and immediately `upserts` them into the `reports` table.
- **Metadata Persistence:** User-entered metadata is stored only in the database. During the sync, the system merges the existing DB metadata back into the scanned objects. This ensures that manually added info like 'UAT NA' remains attached to the report even if the server restarts.
- **Archiving Logic:** When a report is moved to the Archive, the backend physically renames the folder. The database record is then updated to point to the new folder ID and new physical path, preserving the metadata across the move.
- **Cleanup:** Stale database records (reports that exist in the DB but were deleted manually from the filesystem) are purged during the scan to keep the database and UI in perfect alignment.

---

## 🚀 Integrated Test Runner

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

To reliably know where a given test project's aria snapshots are stored, the backend needs to read the user's `playwright.config.ts`.
- **The Problem:** Node cannot natively `require()` a TypeScript file without compilation.
- **The Solution:** We use `jiti` to dynamically transpile and import the config on the fly.
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

## 💅 Frontend "Deep Equal" UI Toggle

When developers fix aria snapshots, they frequently want to enforce `deep-equal` checking across the entire body.
- The Preview UI Modal includes a "Deep Equal" checkbox in the footer.
- It is `checked` by default.
- `app.ts` contains logic that dynamically prepends `- /children: deep-equal\n` to the top of all textareas when checked, and precisely removes it when unchecked, ensuring the user can apply the validation globally with a single click before submitting to the `/api/fix-aria-snapshot` endpoint.
