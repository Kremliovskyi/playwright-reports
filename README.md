<div align="center">
  <img src="https://playwright.dev/img/playwright-logo.svg" alt="Playwright logo" width="100" />
  <h1>Playwright Test Reports Central</h1>
  <p><em>A local dashboard to run, view, archive, and analyze Playwright tests and reports.</em></p>

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Express.js](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![PM2](https://img.shields.io/badge/PM2-2B037A?style=for-the-badge&logo=pm2&logoColor=white)](https://pm2.keymetrics.io/)

<br />
<img src="./screenshots/dashboard.png" alt="Playwright Reports dashboard" width="800" />
</div>

## What it does

Playwright Test Reports Central brings local Playwright workflows into one dashboard:

- Open, search, label, archive, and delete Playwright HTML reports.
- Run local or BrowserStack tests with saved project presets and live terminal output.
- Analyze failed tests with [`@andrii_kremlovskyi/playwright-traces-reader`](https://www.npmjs.com/package/@andrii_kremlovskyi/playwright-traces-reader) and GitHub Copilot.
- Digest individual traces into structured steps, network data, and console output.
- Review and apply failed aria snapshot updates.
- View and edit Markdown analysis notes associated with reports.
- Expose a local-first API for agents to discover and prepare reports for analysis.

The application runs locally because it needs access to Playwright projects, report directories, SQLite, and the host filesystem.

## Documentation

| Guide | What it covers |
| --- | --- |
| [Documentation home](docs/index.md) | Guided entry point and workflow map |
| [Getting started](docs/getting-started.md) | Installation, startup, PM2, and launch on reboot |
| [Configuration](docs/configuration.md) | Paths, BrowserStack, Copilot, and model selection |
| [Running tests](docs/running-tests.md) | Projects, presets, options, BrowserStack, and live output |
| [Managing reports](docs/reports.md) | Search, metadata, bulk actions, archive, delete, traces, and notes |
| [Failure analysis](docs/failure-analysis.md) | Analyze failed attempts and inspect generated output |
| [Trace digestion](docs/trace-digestion.md) | Parse one test trace into structured data |
| [Aria snapshot fixer](docs/aria-snapshots.md) | Review and apply failed accessibility snapshots |
| [Agent API](docs/agent-api.md) | Discover and prepare reports for `playwright-traces-reader` |
| [Troubleshooting](docs/troubleshooting.md) | Startup, report discovery, runner, Copilot, and BrowserStack checks |


## Development

See [ARCHITECTURE.md](ARCHITECTURE.md) before changing report discovery, filesystem synchronization, database identity, or analysis workflows.

```bash
npm run build
npm run restart
npm run logs
```

## Disclaimer

"Playwright" is a trademark of Microsoft Corporation. This independent, community-driven project is not affiliated with, endorsed by, or sponsored by Microsoft or the official Playwright team.

## License

This project is available under the [MIT License](LICENSE).