import AdmZip from "adm-zip";

export interface ExtractionTask {
  zipFile: string;
  stagingDir: string;
}

export type ExtractionResult =
  | { ok: true }
  | { ok: false; error: string };

process.on("message", (task: ExtractionTask) => {
  let result: ExtractionResult;
  try {
    new AdmZip(task.zipFile).extractAllTo(task.stagingDir, true);
    result = { ok: true };
  } catch (error) {
    result = {
      ok: false,
      error: `Failed to extract ${task.zipFile}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (process.connected)
    process.send?.(result, (error) => {
      if (error) {
        console.error("Extraction worker IPC error:", error);
        process.exitCode = 1;
        if (process.connected) process.disconnect?.();
      }
    });
});
