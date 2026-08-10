import { fork } from "node:child_process";
import path from "node:path";

export type PlaywrightConfigProjection = {
  projectNames: string[];
  ariaSnapshotPathTemplate?: string;
};

type LoaderResponse =
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

    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_LENGTH)
        stderr += chunk.toString().slice(0, MAX_STDERR_LENGTH - stderr.length);
    });

    const cleanup = () => {
      clearTimeout(timeout);
      child.removeAllListeners();
      child.stderr?.removeAllListeners();
    };
    const finish = (callback: () => void, terminateChild: boolean = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminateChild && !child.killed) child.kill();
      callback();
    };
    const diagnostic = () => (stderr.trim() ? `\n${stderr.trim()}` : "");

    const timeout = setTimeout(() => {
      finish(
        () =>
          reject(
            new Error(
              `Timed out loading Playwright config after ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms${diagnostic()}`,
            ),
          ),
        true,
      );
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

    child.once("message", (message) => {
      if (!isLoaderResponse(message)) {
        finish(
          () =>
            reject(new Error("Invalid response from Playwright config loader")),
          true,
        );
        return;
      }
      if (!message.ok) {
        finish(
          () => reject(new Error(`${message.error}${diagnostic()}`)),
          true,
        );
        return;
      }
      finish(() => resolve(message.projection));
    });
    child.once("error", (error) => {
      finish(() => reject(error), true);
    });
    child.once("exit", (code, signal) => {
      finish(() =>
        reject(
          new Error(
            `Playwright config loader exited before responding (code ${code}, signal ${signal})${diagnostic()}`,
          ),
        ),
      );
    });
  });
};
