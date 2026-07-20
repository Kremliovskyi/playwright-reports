# Troubleshooting

[Back to documentation](index.md)

## The dashboard does not open

Check whether PM2 has a running process and inspect its logs:

```bash
npx pm2 status
npm run logs
```

The default address is [http://localhost:9333](http://localhost:9333). If `ecosystem.config.js` uses another port, open that address instead.

After changing source code, rebuild and restart the process:

```bash
npm run restart
```

See [Getting Started](getting-started.md) for all server management commands.

## Reports do not appear

1. Open **Preferences** and verify that Current Reports Directory is an absolute path.
2. Confirm that each expected report folder contains a Playwright `index.html` file.
3. Click **Refresh** to run a new filesystem-to-database sync.
4. If a search filter is active, click **Search**, then **Reset**.

## The test runner has no projects

Verify that Playwright Project Path points to the directory containing `playwright.config.ts`. The dashboard resolves projects from that configuration file.

## Failure analysis cannot select a model

Click the header's **Copilot** chip to see the current authentication or model error. Then check the Copilot tab in **Preferences** and confirm that the host's Copilot CLI or GitHub CLI session is authenticated, or provide an appropriate GitHub token.

See [Configuration](configuration.md) for model selection behavior.

## Failure analysis fails with a trace-cache `EPERM` error

An error containing `EPERM: operation not permitted, rename` and a path below `%TEMP%\playwright-traces-reader\trace-cache` is a trace ZIP cache publication failure on Windows. Current versions serialize analysis of the same report, accept a verified cache entry produced by another process, and retry transient antivirus or indexing locks.

If the error persists:

1. Wait for other dashboard analyses or standalone `playwright-traces-reader` commands to finish.
2. Rebuild and restart the dashboard so the server and installed reader version are current: `npm run restart`.
3. With no reader command running, remove the disposable cache in PowerShell:

	```powershell
	Remove-Item "$env:TEMP\playwright-traces-reader\trace-cache" -Recurse -Force
	```

4. Retry **Analyze Failures** once. If it still fails, inspect `npm run logs` and check whether antivirus, indexing software, or directory permissions are repeatedly locking the reported path.

Deleting this cache does not modify reports or previous analysis output. ZIP traces are extracted again when needed.

## BrowserStack runs do not start

Check the BrowserStack tab in **Preferences** for the username, access key, and config filename. The config path is relative to the configured Playwright project root.

## More technical detail

See [Developer Architecture](../ARCHITECTURE.md) for database, filesystem synchronization, report identity, and endpoint behavior.