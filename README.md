<div align="center">
  <img src="https://playwright.dev/img/playwright-logo.svg" alt="Playwright Logo" width="100"/>
  <h1>Playwright Test Reports Central</h1>
  <p><em>A centralized, dependency-free dashboard to run, view, archive, and extract Playwright tests.</em></p>

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)]()
[![Express.js](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)]()
[![PM2](https://img.shields.io/badge/PM2-2B037A?style=for-the-badge&logo=pm2&logoColor=white)]()

<br><br>
<img src="./screenshots/dashboard.png" alt="Dashboard View" width="800" style="border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); margin-bottom: 20px;"/>
<br>
<img src="./screenshots/runner.png" alt="Integrated Test Runner" width="800" style="border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3);"/>

</div>

---

## ✨ Features

- **🚀 Integrated Test Runner:** Run your Playwright tests directly from the dashboard. Select projects, apply greps, configure workers, and watch the live colored terminal output stream in real-time.
- **⭐ Test Presets:** Save your favorite project and option combinations as "Presets" to instantly recall complex test environments with one click.
- **�️ Preset Validation:** Automatically detects if a preset refers to projects that have been removed from your `playwright.config.ts`, preventing execution errors.
- **�📊 Unified Dashboard:** View all your Playwright HTML reports in one beautifully styled, dark-mode native interface.
- **📦 Trace Extraction:** Extract `.zip` trace files found in your reports with a single click—perfect for feeding raw DOM/Network data to AI agents.
- **🗃️ Single-Click Archiving:** Move important runs out of your cluttered active folder and safely into a historical Archive directory.
- **🗑️ Delete Reports:** Delete obsolete or unwanted reports from either the Current or Archived folder with a single click and confirmed via a custom dialog.
- **⚙️ Centralized Configuration:** Manage all your workspace paths and persistent runner options through a visual Preferences UI, backed by a persistent **SQLite** database (`app.db`).
- **🔌 Zero Local Dependencies:** Serve reports reliably via PM2 without needing Playwright installed globally.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: Installed on your machine (download from [nodejs.org](https://nodejs.org/)).
- **PM2**: (Optional but recommended) for running the server in the background. Install globally via `npm install -g pm2`.

### Installation

1. Clone or copy this repository to your machine.
2. Navigate to the project directory in your terminal.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the application:
   ```bash
   npm start
   ```

Once started, open your browser and navigate to:  
👉 **[http://localhost:9333](http://localhost:9333)** _(or the port configured in your ecosystem file)_

---

## 🛠️ Configuration

When you first launch the app, you'll need to configure your workspaces:

1. Click the **⚙️ Preferences** button in the top right.
2. Set your directory paths (use absolute paths):
   - **Current Reports Directory:** The folder where your Playwright project outputs new runs (e.g., `playwright-report`).
   - **Archived Reports Directory:** A folder where you want to store historical test runs.
   - **Playwright Project Path:** The directory containing your `playwright.config.ts` (required for the Test Runner).
3. Click **Save Changes**. The dashboard will instantly scan the directories and display any valid reports.

> **Note:** Configuration and Presets are stored in a local **SQLite** database (`app.db`), ensuring high reliability and zero-configuration data management.

---

## 🏃‍♂️ Integrated Test Runner

Click **Run Tests** from the main dashboard to open the runner interface.

- **Dynamic Discovery:** Automatically parses your `playwright.config.ts` to detect available projects.
- **Presets System:** Save your current selection of projects and CLI arguments as a named preset for instant reuse later.
- **Discrepancy Checks:** If you apply a preset but the underlying projects in your config have changed, the runner will notify you exactly what is missing via a clear dialog.
- **Options Persistence:** Your selections (Headed, UI Mode, custom Greps, Workers, Env Variables) are safely saved so they persist across reboots.
- **Live Output:** Features an integrated `xterm.js` terminal to stream your test execution exactly as it looks in a native console.
- **Graceful Termination:** You can stop running tests at any time without leaving zombie Node processes.

---

## 📦 Trace Extraction (AI Ready)

Playwright packages test traces (network logs, DOM snapshots) into `.zip` files.

Having extracted traces as raw JSON/network files allows AI agents to easily read and interact with your test run data (e.g., automatically generating Jira defects or API assertions).

- Click **Extract** next to any report to automatically unzip its trace files on the host machine.
- Click **Extract All Traces** to bulk-process your entire workspace. _The extraction is idempotent and will quickly skip already-extracted runs._

---

## 🗃️ Archiving Reports

Keep your active workspace clean by archiving old runs.

- Click **Archive** on any report in the "Current Test Reports" table.
- The report folder is safely moved to your configured Archive path and appended with a unique timestamp (`playwright-report-174000...`) to absolutely guarantee no collisions.

---

## 🗑️ Deleting Reports

If a report is no longer needed (whether it's in Current or Archived), you can completely remove it to free up disk space.

- Click **Delete** on any report in the tables.
- A confirmation dialog will appear, displaying the exact creation date of the report, to ensure you don't delete the wrong run.
- Upon confirming **Yes**, the backend will recursively and permanently remove the report directory from the disk system.
- The dashboard automatically refreshes to reflect the change immediately.

---

## 💻 PM2 Server Management

If you started the server with `npm start`, it runs in the background using PM2. You can manage it using the following npm scripts:

| Command           | Description                                                |
| ----------------- | ---------------------------------------------------------- |
| `npx pm2 status`  | Check the status of the background process                 |
| `npm run logs`    | View the live console output of the server                 |
| `npm run restart` | Restart the dashboard (useful if you manually edit config) |
| `npm run stop`    | Stop the server from running                               |
| `npm run delete`  | Remove the server from PM2 entirely                        |

### Auto-start on Reboot

To make the dashboard automatically start when your computer boots:

**Windows:**

```cmd
npm install pm2-windows-startup -g
pm2-startup install
pm2 save
```

**macOS / Linux:**

```bash
pm2 startup
# (Run the specific sudo command PM2 outputs here)
pm2 save
```

---

## ⚖️ Disclaimer

"Playwright" is a trademark of Microsoft Corporation. This project is an independent, community-driven tool and is **not** affiliated with, endorsed by, or sponsored by Microsoft or the official Playwright team.

## 📝 License

This project is open-source and available under the [MIT License](LICENSE).
