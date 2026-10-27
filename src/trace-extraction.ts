import { fork, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { PREPARATION_WORKERS } from "./report-preparation";
import type { ExtractionResult, ExtractionTask } from "./trace-extraction-worker";

export interface ExtractionProgress {
  completed: number;
  total: number;
}

export async function extractReportTraces(
  dataDir: string,
  options: {
    beforePublish?: () => void;
    onProgress?: (progress: ExtractionProgress) => void;
  } = {}
): Promise<number> {
  const entries = await fs.promises.readdir(dataDir, { withFileTypes: true });
  const archives = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".zip"))
    .map((entry) => {
      const name = entry.name.slice(0, -4);
      if (!name || name === "." || name === "..")
        throw new Error(`Invalid trace archive name: ${entry.name}`);
      return {
        zipFile: path.join(dataDir, entry.name),
        target: path.join(dataDir, name)
      };
    })
    .filter(({ target }) => !fs.existsSync(target));
  options.onProgress?.({ completed: 0, total: archives.length });
  if (!archives.length) return 0;
  const stagingRoot = await fs.promises.mkdtemp(path.join(dataDir, ".extract-"));
  let cursor = 0;
  let completed = 0;
  let extracted = 0;
  let failure: Error | undefined;
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
  };

  const runWorker = async (): Promise<void> => {
    if (failure) return;
    let child: ChildProcess;
    try {
      child = fork(path.join(__dirname, "trace-extraction-worker.js"), [], {
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      });
    } catch (error) {
      fail(error);
      return;
    }
    let stderr = "";
    let stopping = false;
    let currentZip = "";
    let pending: {
      resolve: (result: ExtractionResult) => void;
      reject: (error: Error) => void;
    } | undefined;
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk).slice(0, Math.max(0, 8192 - stderr.length));
    });
    child.on("message", (result: ExtractionResult) => {
      const request = pending;
      pending = undefined;
      if (!request) {
        fail(new Error("Unexpected extraction worker response."));
        return;
      }
      request.resolve(result);
    });
    child.on("error", (error) => {
      fail(error);
      pending?.reject(error);
      pending = undefined;
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        if (!stopping || code !== 0) {
          const error = new Error(
            `Extraction worker exited (${signal ?? code}) while extracting ${currentZip}${stderr ? `: ${stderr.trim()}` : ""}`
          );
          fail(error);
          pending?.reject(error);
          pending = undefined;
        }
        resolve();
      });
    });
    try {
      while (!failure && cursor < archives.length) {
        const index = cursor++;
        const archive = archives[index];
        currentZip = archive.zipFile;
        const stagingDir = path.join(stagingRoot, String(index));
        const result = await new Promise<ExtractionResult>((resolve, reject) => {
          pending = { resolve, reject };
          child.send({ zipFile: currentZip, stagingDir } satisfies ExtractionTask, (error) => {
            if (error) {
              fail(error);
              pending?.reject(error);
              pending = undefined;
            }
          });
        });
        if (!result.ok) throw new Error(result.error);
        if (failure) break;
        options.beforePublish?.();
        if (!fs.existsSync(archive.target)) {
          fs.renameSync(stagingDir, archive.target);
          extracted++;
        }
        options.onProgress?.({ completed: ++completed, total: archives.length });
      }
    } catch (error) {
      fail(error);
    } finally {
      stopping = true;
      if (child.connected) child.disconnect();
      // Wait for the writer to exit; parent-side IPC disconnection does not
      // reliably emit "close". Failed spawns have no process to drain.
      if (child.pid !== undefined) await exited;
    }
  };

  try {
    await Promise.all(Array.from(
      { length: Math.min(PREPARATION_WORKERS, archives.length) },
      () => runWorker()
    ));
    if (failure) throw failure;
    return extracted;
  } finally {
    try {
      await fs.promises.rm(stagingRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      });
    } catch (error) {
      throw new Error(`${failure ? failure.message + "\n" : ""}Failed to clean extraction staging ${stagingRoot}: ${error}`);
    }
  }
}
