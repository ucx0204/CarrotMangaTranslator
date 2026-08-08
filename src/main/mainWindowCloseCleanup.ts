import type { AppOperationRegistry } from "./appOperationRegistry";
import type { ActiveJobStore } from "./jobs/activeJob";
import { finishActiveJobCleanup } from "./jobs/beforeQuitCleanup";

type MainWindowCloseCleanupJobs = Pick<
  ActiveJobStore,
  "current" | "clearIfCurrent" | "runCleanup"
>;

type MainWindowCloseCleanupOperations = Pick<
  AppOperationRegistry,
  "current" | "abortCurrentAndWait"
>;

type MainWindowCloseCleanupLogger = (message: string, detail?: unknown) => void;

export async function runMainWindowCloseCleanup({
  jobs,
  operations,
  waitForLibraryMutations,
  disposeInpainting,
  disposeTranslation,
  logError,
  logWarn,
}: {
  jobs: MainWindowCloseCleanupJobs;
  operations: MainWindowCloseCleanupOperations;
  waitForLibraryMutations: () => Promise<void>;
  disposeInpainting: () => Promise<unknown>;
  disposeTranslation: () => Promise<unknown>;
  logError: MainWindowCloseCleanupLogger;
  logWarn: MainWindowCloseCleanupLogger;
}): Promise<void> {
  const job = jobs.current;
  if (job) {
    await finishActiveJobCleanup({
      job,
      jobs,
      reason: "main-window-closed",
      warnTimedOut: (jobId, timeoutMs) => {
        logWarn(
          "Timed out waiting for active job cleanup after the main window closed",
          { jobId, timeoutMs },
        );
      },
    });
  }

  if (operations.current) {
    await operations.abortCurrentAndWait("main-window-closed");
  }

  await waitForLibraryMutations();
  await disposeRuntimeResources({
    disposeInpainting,
    disposeTranslation,
    logError,
  });
}

async function disposeRuntimeResources({
  disposeInpainting,
  disposeTranslation,
  logError,
}: {
  disposeInpainting: () => Promise<unknown>;
  disposeTranslation: () => Promise<unknown>;
  logError: MainWindowCloseCleanupLogger;
}): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(disposeInpainting),
    Promise.resolve().then(disposeTranslation),
  ]);
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      logError("Runtime resource disposal failed after main window close", {
        resource: index === 0 ? "inpainting-engines" : "translation-runtime",
        error: result.reason,
      });
    }
  }
}
