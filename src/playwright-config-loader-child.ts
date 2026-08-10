import { createJiti } from "jiti";

type ConfigProjection = {
  projectNames: string[];
  ariaSnapshotPathTemplate?: string;
};

type LoaderResponse =
  | { ok: true; projection: ConfigProjection }
  | { ok: false; error: string };

const sendResponse = (response: LoaderResponse): void => {
  const send = process.send;
  if (!send) return;
  send.call(process, response, () => process.disconnect?.());
};

const loadConfig = async (): Promise<void> => {
  const configPath = process.argv[2];
  if (!configPath) {
    sendResponse({ ok: false, error: "Playwright config path is required" });
    return;
  }

  try {
    const localJiti = createJiti(__filename, {
      moduleCache: false,
      cache: false,
    });
    const importedConfig = (await localJiti.import(configPath)) as any;
    const config = importedConfig.default || importedConfig;
    const projectNames = Array.isArray(config.projects)
      ? config.projects
          .map((project: any) => project?.name)
          .filter(
            (name: unknown): name is string =>
              typeof name === "string" && name.length > 0,
          )
      : [];
    const pathTemplate = config.expect?.toMatchAriaSnapshot?.pathTemplate;

    sendResponse({
      ok: true,
      projection: {
        projectNames,
        ...(typeof pathTemplate === "string"
          ? { ariaSnapshotPathTemplate: pathTemplate }
          : {}),
      },
    });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

void loadConfig();
