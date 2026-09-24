import { releaseModelResource } from "../runtimeSupport/modelCleanupBarrier";

/** The source font worker owns local model resources until termination completes. */
export async function withFontChapterC18Worker<T>(
  worker: { dispose: () => Promise<void> },
  read: () => Promise<T>,
): Promise<T> {
  const failures: unknown[] = [];
  let result!: T;
  try {
    result = await read();
  } catch (error) {
    failures.push(error);
  }
  try {
    await releaseModelResource(worker, () => worker.dispose());
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "C23 source analysis and worker cleanup did not finish.",
    );
  return result;
}
