const hasWhitespace = /\s/;

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
