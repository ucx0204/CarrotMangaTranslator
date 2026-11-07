import { releaseModelResource } from "../runtimeSupport/modelCleanupBarrier";
import { createFontChapterWorkspace } from "../fontChapterWorkspace";

/** Only the unique scratch directory created here belongs to this operation. */
export async function withFontChapterC18Job<T>(
  dataRoot: string,
  prepare: (directory: string) => Promise<{
    worker: { dispose: () => Promise<void> };
    read: () => Promise<T>;
  }>,
): Promise<T> {
  const { directory, remove: cleanup } =
    await createFontChapterWorkspace(dataRoot);
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare(directory);
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "C23 job preparation and cleanup failed.",
        { cause: cleanupError },
      );
    }
    throw error;
  }
  return withFontChapterC18Worker(prepared.worker, prepared.read, cleanup);
}

/** The source font worker owns local model resources until termination completes. */
export async function withFontChapterC18Worker<T>(
  worker: { dispose: () => Promise<void> },
  read: () => Promise<T>,
  cleanup?: () => Promise<void>,
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
    // A failed termination must leave files intact for the still-live worker.
    await cleanup?.();
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
