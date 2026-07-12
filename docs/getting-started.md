# Getting Started

[Back to documentation](index.md)

## Prerequisites

- [Node.js](https://nodejs.org/) installed on your machine.
- Playwright installed in the project whose tests and reports you want to manage.
- [PM2](https://pm2.keymetrics.io/) installed globally with `npm install -g pm2`. PM2 is optional, but recommended for keeping the dashboard running in the background.

The dashboard uses `jiti` internally to resolve Playwright configuration files. It is installed with the project dependencies.

## Install and start

1. Clone the repository:

   ```bash
   git clone https://github.com/Kremliovskyi/playwright-reports.git
   cd playwright-reports
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build and start the application with PM2:

   ```bash
   npm start
   ```

4. Open [http://localhost:9333](http://localhost:9333), or the port configured in `ecosystem.config.js`.

Continue with [Configuration](configuration.md) to connect the dashboard to your reports and Playwright project.

## Manage the server

When started with `npm start`, the dashboard runs in the background using PM2.

| Command | Description |
| --- | --- |
| `npx pm2 status` | Check the background process status |
| `npm run logs` | View live server output |
| `npm run restart` | Rebuild and restart the dashboard |
| `npm run stop` | Stop the dashboard |
| `npm run delete` | Remove the dashboard from PM2 |

## Update the application

Stop the running dashboard, pull the latest changes, install any updated dependencies, and start it again:

```bash
npm run stop
git pull
npm i
npm start
```

## Start automatically after reboot

### Windows

```cmd
npm install pm2-windows-startup -g
pm2-startup install
pm2 save
```

### macOS and Linux

```bash
pm2 startup
# Run the sudo command printed by PM2.
pm2 save
```

## Next steps

- [Configure paths and integrations](configuration.md)
- [Run Playwright tests](running-tests.md)
- [Troubleshoot the dashboard](troubleshooting.md)