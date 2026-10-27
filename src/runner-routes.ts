import { ChildProcess, execFile, spawn } from "child_process";
import type { Express } from "express";
import { Request, Response } from "express";
import fs from "fs";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import path from "path";
import treeKill from "tree-kill";
import { loadPlaywrightConfigProjection } from "./playwright-config-loader";
import {
  buildPodmanArgs,
  formatRunnerArgs,
  prepareRunnerArgs,
  resolvePodmanExecutable,
  resolvePodmanImage
} from "./runner-command";
import {
  discoverRunnerConfigs,
  resolveDiscoveredConfig
} from "./runner-configs";
import { appConfig, broadcastLog, refreshConfigCache, subscribeLogs } from "./runtime";

let activeProcess: ChildProcess | null = null;

let activeHeadlessConfigPath: string | null = null;

let activeContainerName: string | null = null;
let runnerTransition: "starting" | "stopping" | null = null;

const execFileAsync = promisify(execFile);

const podmanExecutable = resolvePodmanExecutable();

const removeHeadlessConfigOverride = (configPath: string | null): void => {
  if (!configPath) return;
  try {
    fs.rmSync(configPath, { force: true });
  } catch (error) {
    console.error(
      `Failed to remove headless config override: ${configPath}`,
      error
    );
  } finally {
    if (activeHeadlessConfigPath === configPath)
      activeHeadlessConfigPath = null;
  }
};

const createHeadlessConfigOverride = (configPath: string): string => {
  const overridePath = path.join(
    path.dirname(configPath),
    `.pw-reports-headless-${randomUUID()}.ts`
  );
  const importPath = `./${path.basename(configPath)}`;
  const source = [
    `import baseConfig from ${JSON.stringify(importPath)};`,
    "",
    "export default {",
    "  ...baseConfig,",
    "  use: { ...baseConfig.use, headless: true },",
    "  projects: baseConfig.projects?.map(project => ({",
    "    ...project,",
    "    use: { ...project.use, headless: true },",
    "  })),",
    "};",
    ""
  ].join("\n");

  fs.writeFileSync(overridePath, source, { flag: "wx" });
  return overridePath;
};

const stopTests = async (): Promise<void> => {
  if (activeContainerName) {
    const containerName = activeContainerName;
    try {
      await execFileAsync(
        podmanExecutable,
        ["rm", "--force", "--ignore", containerName],
        { timeout: 120000 }
      );
      if (activeContainerName === containerName) activeContainerName = null;
    } catch (error: any) {
      throw new Error(
        `Could not stop Podman container ${containerName}: ${error.message}`
      );
    }
  }
  return new Promise((resolve, reject) => {
    if (activeProcess && activeProcess.pid) {
      const processToStop = activeProcess;
      const configPathToRemove = activeHeadlessConfigPath;
      treeKill(processToStop.pid!, "SIGKILL", (error) => {
        if (error && activeProcess === processToStop) {
          reject(new Error(`Could not stop tests: ${error.message}`));
          return;
        }
        if (activeProcess === processToStop) {
          activeProcess = null;
          broadcastLog("complete", "1");
        }
        removeHeadlessConfigOverride(configPathToRemove);
        resolve();
      });
    } else {
      removeHeadlessConfigOverride(activeHeadlessConfigPath);
      resolve();
    }
  });
};

export function registerRunnerRoutes(app: Express): void {

  app.get(
    "/api/runner-configs",
    async (req: Request, res: Response): Promise<any> => {
      refreshConfigCache();
      if (!appConfig.projectPath || !fs.existsSync(appConfig.projectPath)) {
        return res.json({ playwrightConfigs: [], browserstackConfigs: [] });
      }

      try {
        return res.json(await discoverRunnerConfigs(appConfig.projectPath));
      } catch (error: any) {
        console.error("Error discovering runner configs:", error);
        return res.status(500).json({ error: error.message });
      }
    }
  );

  app.get("/api/projects", async (req: Request, res: Response): Promise<any> => {
    refreshConfigCache();
    if (!appConfig.projectPath || !fs.existsSync(appConfig.projectPath)) {
      return res.json({ projects: [] });
    }

    try {
      const { playwrightConfigs } = await discoverRunnerConfigs(
        appConfig.projectPath
      );
      const requestedConfig =
        typeof req.query.config === "string" ? req.query.config : "";
      const selectedConfig = requestedConfig || playwrightConfigs[0];
      if (!selectedConfig) return res.json({ projects: [] });
      const configPath = resolveDiscoveredConfig(
        appConfig.projectPath,
        selectedConfig,
        playwrightConfigs,
        "Playwright config"
      );

      const projection = await loadPlaywrightConfigProjection(configPath, {
        cwd: appConfig.projectPath
      });
      return res.json({
        projects: projection.projectNames,
        config: selectedConfig
      });
    } catch (error: any) {
      console.error("Error parsing config:", error);
      return res.status(400).json({ projects: [], error: error.message });
    }
  });

  app.get("/api/logs", subscribeLogs);

  app.post("/api/stop-tests", async (req: Request, res: Response) => {
    if (runnerTransition) {
      res.status(409).json({ error: `The runner is ${runnerTransition}. Wait for it to finish.` });
      return;
    }
    runnerTransition = "stopping";
    try {
      await stopTests();
      broadcastLog("output", "\nTests stopped by user.\n");
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    } finally {
      runnerTransition = null;
    }
  });

  app.post(
    "/api/run-tests",
    async (req: Request, res: Response): Promise<any> => {
      if (runnerTransition)
        return res.status(409).json({ error: `The runner is ${runnerTransition}. Wait for it to finish.` });
      runnerTransition = "starting";
      const config = appConfig;
      try {

        const {
          args = [],
          env = {},
          useBrowserstack = false,
          usePodman = false,
          headless = false,
          playwrightConfig = "",
          browserstackConfig = ""
        } = req.body;
        if (!config.projectPath) {
          return res.status(400).json({ error: "Project path is not configured" });
        }
        if (
          !Array.isArray(args) ||
          args.some((arg) => typeof arg !== "string") ||
          !env ||
          typeof env !== "object" ||
          Array.isArray(env) ||
          Object.values(env).some((value) => typeof value !== "string")
        ) {
          return res
            .status(400)
            .json({ error: "Invalid runner arguments or environment variables" });
        }
        if (
          usePodman &&
          (useBrowserstack ||
            args.some((arg: string) =>
              /^(--headed|--debug|--ui(?:-host|-port)?)(=|$)/.test(arg)
            ))
        ) {
          return res.status(400).json({
            error:
              "Podman runs are headless and cannot use BrowserStack, Headed, UI Mode or Debug"
          });
        }
        if (headless && useBrowserstack) {
          return res.status(400).json({
            error: "Headless override is not available for BrowserStack runs"
          });
        }

        let selectedPlaywrightConfigPath: string;
        try {
          const discoveredConfigs = await discoverRunnerConfigs(
            config.projectPath
          );
          selectedPlaywrightConfigPath = resolveDiscoveredConfig(
            config.projectPath,
            playwrightConfig,
            discoveredConfigs.playwrightConfigs,
            "Playwright config"
          );
          if (useBrowserstack) {
            if (!config.browserstackUsername || !config.browserstackAccessKey)
              throw new Error("BrowserStack credentials are not configured");
            resolveDiscoveredConfig(
              config.projectPath,
              browserstackConfig,
              discoveredConfigs.browserstackConfigs,
              "BrowserStack config"
            );
          }
        } catch (error: any) {
          return res.status(400).json({ error: error.message });
        }

        let podmanImage = "";
        if (usePodman) {
          try {
            podmanImage = resolvePodmanImage(config.projectPath);
            await execFileAsync(podmanExecutable, ["info", "--format", "json"], {
              timeout: 120000
            });
          } catch (error: any) {
            return res.status(400).json({
              error: podmanImage
                ? "Podman is unavailable. Install Podman on the reports server and start its machine (podman machine start on Windows/macOS), then retry."
                : error.message
            });
          }
          try {
            await execFileAsync(
              podmanExecutable,
              ["image", "inspect", podmanImage],
              { timeout: 120000 }
            );
          } catch {
            return res.status(400).json({
              error: `Prepare the matching image first: podman pull ${podmanImage}`
            });
          }
        }

        const customEnv = { ...process.env, FORCE_COLOR: "1", ...env };
        if (useBrowserstack) {
          customEnv.BROWSERSTACK_USERNAME = config.browserstackUsername;
          customEnv.BROWSERSTACK_ACCESS_KEY = config.browserstackAccessKey;
          customEnv.PLAYWRIGHT_HTML_OPEN = "never";
        }
        const command = usePodman
          ? podmanExecutable
          : process.platform === "win32"
            ? "npx.cmd"
            : "npx";

        const finalArgs = prepareRunnerArgs(
          args,
          usePodman ? "linux" : process.platform
        );

        let headlessConfigPath: string | null = null;
        const containerName = usePodman ? `pw-reports-${randomUUID()}` : null;
        try {
          if (activeProcess) await stopTests();
          let runConfig = playwrightConfig;
          if (headless || usePodman) {
            headlessConfigPath = createHeadlessConfigOverride(
              selectedPlaywrightConfigPath
            );
            activeHeadlessConfigPath = headlessConfigPath;
            runConfig = path.relative(config.projectPath, headlessConfigPath);
          }
          if (usePodman) runConfig = runConfig.replaceAll("\\", "/");
          const shellConfigArgument =
            !usePodman && process.platform === "win32"
              ? `"${runConfig}"`
              : runConfig;
          finalArgs.push("--config", shellConfigArgument);
          if (useBrowserstack)
            finalArgs.push(
              `--browserstack.config=${process.platform === "win32"
                ? `"${browserstackConfig}"`
                : browserstackConfig
              }`
            );

          const spawnArgs = usePodman
            ? buildPodmanArgs({
              projectPath: path.resolve(config.projectPath),
              image: podmanImage,
              containerName: containerName!,
              args: finalArgs,
              env: { FORCE_COLOR: "1", ...env }
            })
            : useBrowserstack
              ? ["browserstack-node-sdk", "playwright", "test", ...finalArgs]
              : ["playwright", "test", ...finalArgs];
          const logPrefix = usePodman
            ? `Podman (${podmanImage}): npm ci && npx playwright test`
            : useBrowserstack
              ? "browserstack-node-sdk playwright test"
              : "npx playwright test";

          const child = spawn(command, spawnArgs, {
            cwd: config.projectPath,
            env: customEnv,
            shell: !usePodman && process.platform === "win32" // On Windows we usually need shell for npx
          });

          activeProcess = child;
          activeContainerName = containerName;
          broadcastLog(
            "start",
            `Running ${logPrefix} ${formatRunnerArgs(finalArgs)}\n`
          );

          child.stdout?.on("data", (data) =>
            broadcastLog("output", data.toString())
          );
          child.stderr?.on("data", (data) =>
            broadcastLog("output", data.toString())
          );

          child.on("close", (code) => {
            if (activeProcess === child) {
              broadcastLog("output", `\nProcess exited with code ${code}\n`);
              broadcastLog("complete", code?.toString() || "1");
              activeProcess = null;
            }
            if (activeContainerName === containerName) activeContainerName = null;
            removeHeadlessConfigOverride(headlessConfigPath);
          });
          child.on("error", (error) => {
            if (activeProcess === child) {
              broadcastLog("output", `\nFailed to start tests: ${error.message}\n`);
              broadcastLog("complete", "1");
              activeProcess = null;
            }
            if (activeContainerName === containerName) activeContainerName = null;
            removeHeadlessConfigOverride(headlessConfigPath);
          });

          res.json({ success: true });
        } catch (error: any) {
          removeHeadlessConfigOverride(headlessConfigPath);
          res.status(500).json({ error: error.message });
        }
      } finally {
        runnerTransition = null;
      }
    }
  );
}
