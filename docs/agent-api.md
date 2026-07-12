# Agent API

[Back to documentation](index.md)

The dashboard exposes a local-first API for discovering reports and resolving them into paths that [`playwright-traces-reader`](https://www.npmjs.com/package/@andrii_kremlovskyi/playwright-traces-reader) can analyze.

## Report discovery

### `GET /api/agent/reports/search`

Searches the persisted report index and returns descriptors with an opaque, stable `reportRef`. Each descriptor also contains `analysisFiles`, an array of available `run-<timestamp>` vault note names.

### `GET /api/agent/reports/prepare?reportRef=...`

Resolves a selected report descriptor into local analysis-ready values such as the report root and `data/` directory.

Treat `reportRef` as opaque. Do not construct report filesystem paths from it.

## Vault access

- `GET /api/agent/vault/list` lists available Markdown analysis notes.
- `GET /api/agent/vault/:filename` returns one note as raw Markdown.

## Companion CLI workflow

```bash
npx playwright-traces-reader search-reports "UAT EU" --limit 1
npx playwright-traces-reader prepare-report <reportRef>
npx playwright-traces-reader failures <reportRootPath>
npx playwright-traces-reader summary <tracePath>
npx playwright-traces-reader vault-read <runName>
```

The intended sequence is:

1. Search for a report in the dashboard's persisted index.
2. Prepare the selected `reportRef` to resolve its local path.
3. Run a `playwright-traces-reader` analysis command against that path.
4. Read a named analysis file when the search result exposes one.

## Responsibility boundary

`playwright-reports` owns report inventory, metadata and date search, and local path resolution. It does not parse traces or reimplement summary, network, DOM, or failure-analysis commands.

`playwright-traces-reader` owns trace parsing and higher-level analysis. A future remote-storage implementation can materialize the report behind the same prepare step without changing the parser's contract.
