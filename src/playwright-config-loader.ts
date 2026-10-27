import { fork } from "node:child_process";
import path from "node:path";

export type PlaywrightConfigProjection = {
  projectNames: string[];
  ariaSnapshotPathTemplate?: string;
};

export type LoaderResponse =
  | { ok: true; projection: PlaywrightConfigProjection }
  | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDERR_LENGTH = 8_192;

const isLoaderResponse = (value: unknown): value is LoaderResponse => {
  if (!value || typeof value !== "object" || !("ok" in value)) return false;
  const response = value as Record<string, unknown>;
  if (response.ok === false) return typeof response.error === "string";
  if (response.ok !== true || !response.projection) return false;
  const projection = response.projection as Record<string, unknown>;
  return (
    Array.isArray(projection.projectNames) &&
    projection.projectNames.every((name) => typeof name === "string") &&
    (projection.ariaSnapshotPathTemplate === undefined ||
      typeof projection.ariaSnapshotPathTemplate === "string")
  );
};

export const loadPlaywrightConfigProjection = (
  configPath: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<PlaywrightConfigProjection> => {
  if (!path.isAbsolute(configPath))
    return Promise.reject(new Error("Playwright config path must be absolute"));

  return new Promise((resolve, reject) => {
    const child = fork(
      path.join(__dirname, "playwright-config-loader-child.js"),
      [configPath],
      {
        cwd: options.cwd || path.dirname(configPath),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    let settled = false;
    let response: LoaderResponse | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;

    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_LENGTH)
        stderr += chunk.toString().slice(0, MAX_STDERR_LENGTH - stderr.length);
    });

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(terminationTimer);
      child.removeAllListeners();
      child.stderr?.removeAllListeners();
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const diagnostic = () => (stderr.trim() ? `\n${stderr.trim()}` : "");
    const terminate = (result: LoaderResponse) => {
      if (settled || response) return;
      response = result;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      terminationTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    };

    const timeout = setTimeout(() => {
      terminate({
        ok: false,
        error: `Timed out loading Playwright config after ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms${diagnostic()}`,
      });
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

    child.once("message", (message) => {
      if (!isLoaderResponse(message)) {
        terminate({ ok: false, error: "Invalid response from Playwright config loader" });
        return;
      }
      if (!message.ok) {
        terminate({ ok: false, error: `${message.error}${diagnostic()}` });
        return;
      }
      terminate(message);
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("exit", (code, signal) => {
      finish(() => {
        if (response?.ok) resolve(response.projection);
        else reject(new Error(response?.error ||
          `Playwright config loader exited before responding (code ${code}, signal ${signal})${diagnostic()}`));
      });
    });
  });
};
