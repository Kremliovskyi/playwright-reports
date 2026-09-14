# Running Tests

[Back to documentation](index.md) | [Previous: Configuration](configuration.md) | [Next: Managing Reports](reports.md)

Click **Run Tests** on the dashboard to open the integrated runner.

![Integrated Playwright test runner](../screenshots/runner.png)

## Choose configurations

The runner recursively discovers configuration files below the configured Playwright Project Path:

- `**/*playwright*.config.{ts,js,mts,mjs,cts,cjs}`
- `**/*browserstack*.{yml,yaml}`

Select a Playwright config first. Its relative path is persisted and its projects are loaded immediately. BrowserStack configs use the same relative-path persistence; their dropdown remains visible but disabled until **BrowserStack Run** is enabled. Files below `node_modules` and `test-results` are ignored.

## Choose what to run

The runner parses the selected Playwright config and lists its projects. Select the required projects, then configure the available execution options:

- Headed mode
- Headless mode
- UI mode
- Debug mode
- Update snapshots
- Run in Podman (headless container execution)
- Grep filters
- Worker count
- Repeat count
- Environment variables

Runner options are persisted across dashboard restarts.

**Headed** and **Headless** are mutually exclusive overrides. Select neither to use the `use.headless` value from `playwright.config.ts`; select either mode to override that value for the run. Debug mode opens a headed browser, so selecting Debug clears Headless.

## Save project presets

Save the current project selection as a named preset to reuse a common test group. When a preset references projects that do not exist in the selected Playwright config, the runner identifies the missing projects before execution.

## Run on BrowserStack

Select a discovered BrowserStack config, then enable **BrowserStack Run** to dispatch through `browserstack-node-sdk` using credentials from [Configuration](configuration.md).

BrowserStack mode automatically disables Headed, Headless, UI Mode, Debug, Update Snapshots, and Run in Podman, and locks the Workers and Repeat inputs.

## Run in Podman

Enable **Run in Podman** next to **Update Snapshots**. The adjacent info button opens setup instructions. This option is persisted and runs tests headlessly; BrowserStack, Headed, UI Mode and Debug are incompatible.

1. Install Podman or Podman Desktop with the Podman engine on the reports server's machine. Ensure `podman` is on the server process's PATH (restart the server after installation if necessary). Standard Windows per-user and Program Files install locations are also detected automatically.
2. On Windows/macOS, initialize a machine once with `podman machine init` if needed, then start it with `podman machine start` or through Podman Desktop. The machine must be running before tests start. Verify with `podman info`. Native Linux normally does not need a Podman machine.
3. Prepare the version-matched image, for example `podman pull mcr.microsoft.com/playwright:v1.59.0-noble` for Playwright 1.59.0. The runner reads the exact stable version from the project's npm lockfile and reports the required pull command if the image is missing. It does not pull images or start the machine automatically.

No manually started container is needed. Each run creates a temporary container with `--init` and `--ipc=host`, mounts the project read/write at `/work`, installs dependencies using `npm ci --include=dev` in an isolated `node_modules` volume, and runs Playwright. An npm lockfile and registry access are required. Host `node_modules` is not modified; the container and its anonymous dependency volume are removed after completion. **Stop** force-removes the container before terminating the local process.

The lockfile (`npm-shrinkwrap.json`, or otherwise `package-lock.json`) must be in sync with `package.json`. If `npm ci` reports a mismatch, open a terminal in the test project's directory and run `npm install`, then retry. Dependencies are installed afresh for each container run, so startup can take longer than a local run.

Keep report and snapshot output paths inside the mounted project so results persist on the host. Snapshot updates use Linux baselines, which can differ from Windows/macOS screenshots. Configs, dependencies, and paths must support Linux; files outside the project are not mounted. Remote Podman connections must have access to the configured project path.

Only the runner's **System Env Variables**, plus its color and Playwright defaults, are forwarded into the container, not the reports server's entire environment. Private registries may require project `.npmrc` configuration and credentials passed through environment variables. To reach a service on the host, use `host.containers.internal` instead of `localhost`.

Use this mode only with trusted tests and sites: the official image runs as root, disabling Chromium's sandbox. See [Playwright Docker documentation](https://playwright.dev/docs/docker).

## Follow or stop the run

The embedded `xterm.js` terminal streams colored process output while tests run. You can stop an active run from the runner; the dashboard terminates the associated process tree to avoid leaving background Node.js processes.

Completed HTML reports appear in the configured current reports directory and can then be handled from [Managing Reports](reports.md).
