import path from "node:path";
import { glob, type GlobOptionsWithFileTypesFalse } from "glob";

export type RunnerConfigFiles = {
  playwrightConfigs: string[];
  browserstackConfigs: string[];
};

const sortConfigPaths = (first: string, second: string): number => {
  const depth = first.split("/").length - second.split("/").length;
  if (depth !== 0) return depth;

  const nameLength =
    path.posix.basename(first).length - path.posix.basename(second).length;
  if (nameLength !== 0) return nameLength;

  return first.localeCompare(second);
};

export const discoverRunnerConfigs = async (
  projectPath: string,
): Promise<RunnerConfigFiles> => {
  const options: GlobOptionsWithFileTypesFalse = {
    cwd: projectPath,
    nodir: true,
    dot: true,
    follow: false,
    posix: true,
    withFileTypes: false,
    ignore: [
      "**/node_modules/**",
      "**/test-results/**",
      "**/.playwright-reports-headless-*",
      "**/.pw-reports-headless-*",
    ],
  };
  const [playwrightConfigs, browserstackConfigs] = await Promise.all([
    glob("**/*playwright*.config.{ts,js,mts,mjs,cts,cjs}", options),
    glob("**/*browserstack*.{yml,yaml}", options),
  ]);

  return {
    playwrightConfigs: playwrightConfigs.sort(sortConfigPaths),
    browserstackConfigs: browserstackConfigs.sort(sortConfigPaths),
  };
};

export const resolveDiscoveredConfig = (
  projectPath: string,
  relativeConfigPath: string,
  discoveredConfigs: string[],
  label: string,
): string => {
  const normalizedPath = relativeConfigPath.replaceAll("\\", "/");
  if (!normalizedPath || !discoveredConfigs.includes(normalizedPath))
    throw new Error(`${label} is not available under the project path`);

  const projectRoot = path.resolve(projectPath);
  const absolutePath = path.resolve(projectRoot, normalizedPath);
  const relativePath = path.relative(projectRoot, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  )
    throw new Error(`${label} must be inside the project path`);
  return absolutePath;
};
