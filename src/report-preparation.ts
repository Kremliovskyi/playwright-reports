export const PREPARATION_WORKERS = 4;

let preparationTail: Promise<void> = Promise.resolve();

// Each preparation owns the four-worker budget until all its workers exit.
// AI analysis runs outside this queue.
export async function withReportPreparation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const previous = preparationTail;
  let release!: () => void;
  preparationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
