# Development and Local Validation

[Back to documentation](index.md) | [Architecture](../ARCHITECTURE.md)

## Runtime and build

Use a supported Node release from the range in [package.json](../package.json).
Node 22.12+, 24 or 26 are recommended. Node 20.19+ remains compatible with the
declared dependencies. SQLite is a native dependency; changing Node major
versions may require reinstalling dependencies for that runtime.

```bash
npm ci
npm run build
npm run start:foreground
```

The foreground command rebuilds and runs the server without PM2. Stop it with
Ctrl+C. For the persistent application, keep using `npm start`, `npm run restart`
and the other [PM2 commands](getting-started.md).

The two TypeScript configurations compile server and browser code separately.
[copy-assets.js](../copy-assets.js) copies required HTML/CSS and locked xterm
assets/licenses; missing required assets fail the build. There is no bundler.

## Tests remain local

No CI workflow is configured for these suites.

```bash
# Build and run isolated Node/API tests
npm test

# Install the browser used by the local UI tests (once per Playwright update)
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium

# Build and run the local Chromium workflows
npm run test:browser

# Run both suites
npm run test:all
```

On Windows, set `PLAYWRIGHT_SKIP_BROWSER_GC=1` using your shell's environment
syntax, or run `npx playwright install chromium` without that optional setting.
The setting keeps other locally installed browser revisions.

For a focused check after a build:

```bash
node --test tests/report-lifecycle.test.js tests/report-artifacts.test.js
npx playwright test --grep "artifact browser workflow"
```

### Isolation and coverage

- Fixtures use temporary report/project directories, an explicit
  `PLAYWRIGHT_REPORTS_DB_PATH`, random loopback ports and disposable processes.
  They never load the working database or run tests in the configured external
  project. Helpers shut down their children and remove their fixture directories.
- Node tests cover report retention/reconciliation, stale mutations, migrations,
  artifact rollback, config-child termination, local runner ownership, ARIA,
  API errors, search/trends, evidence/grouping and CLI installation contracts.
- The local browser runner executes the existing archive, artifact, title-filter
  and trends scenarios, plus local terminal/save-error, scan-warning and stale
  confirmation checks. External requests
  are blocked for the hub pages. Screenshots and failure traces are ignored under
  `tests/.browser-results/`.
- Trace-viewer coverage installs a stale service worker deliberately, checks
  bounded recovery and preservation of genuine errors, and loads a real trace
  with the installed Playwright viewer. Serving tests ensure the guard does not
  rewrite report files or alter snapshots and worker assets.
- Copilot responses and trace jobs use synthetic fixtures. The browser scenarios
  retain their existing mocked mode checks; no live BrowserStack or Podman tests
  are added or run.
- The supplied-real-report trace matrix stays opt-in. See
  [Agent API verification](agent-api.md#verification). A default-suite skip for
  that test is expected.

## Maintenance discipline

Add a regression before changing lifecycle behavior. Keep behavior changes
separate from mechanical movement where practical. Do not migrate/rewrite
existing report identities, notes or directories merely to simplify code.

Follow the boundaries in [Architecture](../ARCHITECTURE.md). Keep business rules
near their owning implementation and user-facing behavior in the relevant guide,
rather than copying detailed UI implementation notes between documents.

Use `npm audit` when changing dependencies and review its results separately.
Do not use force-upgrade/downgrade commands to make the audit output disappear.
The PM2 overrides and their compatibility coverage are explained in
[README dependency maintenance](../README.md#dependency-maintenance).
