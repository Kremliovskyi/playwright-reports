# Running Tests

[Back to documentation](index.md) | [Previous: Configuration](configuration.md) | [Next: Managing Reports](reports.md)

Click **Run Tests** on the dashboard to open the integrated runner.

![Integrated Playwright test runner](../screenshots/runner.png)

## Choose what to run

The runner parses the configured `playwright.config.ts` and lists its projects. Select the required projects, then configure the available execution options:

- Headed mode
- UI mode
- Debug mode
- Grep filters
- Worker count
- Repeat count
- Environment variables

Runner options are persisted across dashboard restarts.

## Save project presets

Save the current project selection as a named preset to reuse a common test group. When a preset references projects that no longer exist in `playwright.config.ts`, the runner identifies the missing projects before execution.

## Run on BrowserStack

Enable **BrowserStack** to dispatch the run through `browserstack-node-sdk` using credentials from [Configuration](configuration.md).

BrowserStack mode automatically disables incompatible local options such as Headed, UI Mode, and Debug, and locks the Workers and Repeat inputs.

## Follow or stop the run

The embedded `xterm.js` terminal streams colored process output while tests run. You can stop an active run from the runner; the dashboard terminates the associated process tree to avoid leaving background Node.js processes.

Completed HTML reports appear in the configured current reports directory and can then be handled from [Managing Reports](reports.md).
