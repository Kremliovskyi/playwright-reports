import fs from "fs";
import path from "path";

const hasWhitespace = /\s/;

export const resolvePodmanExecutable = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (platform !== "win32") return "podman";
  const directories = (env.PATH || env.Path || "").split(";").filter(Boolean);
  if (env.LOCALAPPDATA)
    directories.push(path.join(env.LOCALAPPDATA, "Programs", "Podman"));
  if (env.ProgramFiles) {
    directories.push(path.join(env.ProgramFiles, "RedHat", "Podman"));
    directories.push(path.join(env.ProgramFiles, "Podman"));
  }
  return directories.map((directory) => path.join(directory, "podman.exe"))
    .find((executable) => fs.existsSync(executable)) || "podman";
};

export const resolvePodmanImage = (projectPath: string): string => {
  const lockPath = ["npm-shrinkwrap.json", "package-lock.json"]
    .map((name) => path.join(projectPath, name))
    .find((filePath) => fs.existsSync(filePath));
  if (!lockPath)
    throw new Error("Podman runs require an npm lockfile. Run npm install in the test project first.");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const version = lock.packages?.["node_modules/playwright"]?.version
    || lock.packages?.["node_modules/@playwright/test"]?.version
    || lock.dependencies?.playwright?.version
    || lock.dependencies?.["@playwright/test"]?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Podman runs require a stable Playwright version in the project's npm lockfile.");
  return `mcr.microsoft.com/playwright:v${version}-noble`;
};

export const prepareRunnerArgs = (
  args: string[],
  platform: NodeJS.Platform = process.platform,
): string[] => {
  const preparedArgs = [...args];
  if (platform !== "win32") return preparedArgs;

  for (let index = 0; index < preparedArgs.length - 1; index++) {
    if (preparedArgs[index] === "--grep") {
      preparedArgs[index + 1] = `"${preparedArgs[index + 1]}"`;
      index++;
    }
  }
  return preparedArgs;
};

const formatRunnerArg = (arg: string): string => {
  if (!hasWhitespace.test(arg) || (arg.startsWith('"') && arg.endsWith('"')))
    return arg;
  return `"${arg.replaceAll('"', '\\"')}"`;
};

export const formatRunnerArgs = (args: string[]): string =>
  args.map(formatRunnerArg).join(" ");

export const buildPodmanArgs = (options: {
  projectPath: string;
  image: string;
  containerName: string;
  args: string[];
  env: Record<string, string>;
}): string[] => {
  const envNames = Object.keys(options.env);
  if (envNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw new Error("Invalid environment variable name for Podman run");
  return [
    "run", "--rm", "--pull=never", "--init", "--ipc=host",
    "--name", options.containerName,
    "--volume", `${options.projectPath}:/work:Z`,
    "--volume", "/work/node_modules",
    "--workdir", "/work",
    ...envNames.flatMap((name) => ["--env", name]),
    "--env", "PLAYWRIGHT_HTML_OPEN=never",
    "--env", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
    options.image,
    "sh", "-c", 'npm ci --include=dev && exec npx playwright test "$@"',
    "playwright-tests", ...options.args,
  ];
};
