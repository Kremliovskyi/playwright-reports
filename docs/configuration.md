# Configuration

[Back to documentation](index.md) | [Previous: Getting Started](getting-started.md) | [Next: Running Tests](running-tests.md)

After the first launch, open **Preferences** in the top-right corner and configure the dashboard tabs.

<br />
<img src="../screenshots/preferences.png" alt="Playwright Reports dashboard preferences" width="800" />

## Paths

Use absolute paths for each directory.

| Setting | Purpose |
| --- | --- |
| Current Reports Directory | Folder where the Playwright project writes new HTML reports, such as `playwright-report` |
| Archived Reports Directory | Folder where historical reports should be stored |
| Playwright Project Path | Project directory containing `playwright.config.ts`; required by the test runner |
| Obsidian Vault Path | Optional directory containing Markdown analysis files |

## BrowserStack

Configure these fields when tests will run on BrowserStack:

- **BrowserStack Username**: Your BrowserStack username.
- **BrowserStack Access Key**: Your access key. The UI displays this as a password field.
- **BrowserStack Config**: Config filename relative to the Playwright project root, such as `browserstack.falcons.yml`.

## Copilot

The optional **GitHub Token** authenticates the Copilot SDK used for AI failure analysis. When it is empty, the dashboard falls back to the host's Copilot CLI or GitHub CLI login.

Select two model roles in the same tab:

| Setting | Purpose |
| --- | --- |
| Small model | Creates one distilled `ai-analysis.md` record for each analyzable failed attempt |
| Big model | Groups all completed per-attempt records into `grouped-analysis.md` |

Click either model field to open the shared model picker. Selecting a model saves that field immediately; the two roles are independent and may use the same model. Missing or unavailable selections are not replaced automatically.

Click **Save Changes** after editing the settings. The dashboard immediately scans the configured directories and displays valid reports.

Configuration, presets, and report metadata are stored in the local SQLite database `app.db`.

## Check Copilot access

The header's **Copilot** chip reports whether the dashboard can access Copilot.

- On dashboard load, the chip checks authentication and shows `Copilot: ready`, `Copilot: sign in`, or `Copilot: error`.
- Click the chip to run the access check again.
- The chip does not list, select, or replace models. Model selection is available only in **Preferences > Copilot**.
- Analyze Failures validates both selected model IDs before creating an output directory. A missing or stale selection identifies the model role that needs attention.

Continue with [Running Tests](running-tests.md), or go directly to [Managing Reports](reports.md) when reports already exist.
