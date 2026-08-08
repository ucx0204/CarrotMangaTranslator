/* eslint-disable max-lines-per-function -- quit cleanup stage ordering and release gates stay co-located for auditability */
import type { AppOperationRegistry } from "./appOperationRegistry";
import type { AppQuitCleanupProgress } from "./appQuitCoordinator";
import type { ActiveJobStore } from "./jobs/activeJob";
import {
  canReleaseInpaintingHistoryAfterQuitCleanup,
  finishActiveJobCleanup,
} from "./jobs/beforeQuitCleanup";

export type AppTerminalCleanupReason = "app-quit" | "fatal-incident";

type AppQuitCleanupJobs = Pick<
  ActiveJobStore,
  "current" | "clearIfCurrent" | "runCleanup"
>;

type AppQuitCleanupOperations = Pick<
  AppOperationRegistry,
  "current" | "abortCurrentAndWait"
>;

type AppQuitCleanupLogger = (message: string, detail?: unknown) => void;

export async function runAppQuitCleanup({
  jobs,
  operations,
  cancelStartupMaintenance,
  disposeInpainting,
  disposeTranslation,
  waitForLibraryMutations,
  releaseInpaintingHistory,
  updateProgress,
  logError,
  logWarn,
  cleanupReason = "app-quit",
}: {
  jobs: AppQuitCleanupJobs;
  operations: AppQuitCleanupOperations;
  cancelStartupMaintenance: () => void;
  disposeInpainting: () => Promise<unknown>;
  disposeTranslation: () => Promise<unknown>;
  waitForLibraryMutations: () => Promise<void>;
  releaseInpaintingHistory: () => Promise<unknown>;
  updateProgress: (progress: AppQuitCleanupProgress) => void;
  logError: AppQuitCleanupLogger;
  logWarn: AppQuitCleanupLogger;
  cleanupReason?: AppTerminalCleanupReason;
}): Promise<void> {
  updateProgress({ stage: "startup-maintenance-cancel" });
  cancelStartupMaintenanceSafely(
    cancelStartupMaintenance,
    logError,
    cleanupReason,
  );

  let inpaintingHistoryReleaseSafe = true;
  const job = jobs.current;

  if (job) {
    updateProgress({
      stage: "active-job-cleanup",
      jobId: job.id,
      jobKind: job.kind,
    });
    const cleanup = await finishActiveJobCleanup({
      job,
      jobs,
      reason:
        cleanupReason === "fatal-incident" ? "fatal-incident" : "before-quit",
      warnTimedOut: (jobId, timeoutMs) => {
        logWarn(
          cleanupReason === "fatal-incident"
            ? "Timed out waiting for active job cleanup during fatal shutdown"
            : "Timed out waiting for active job cleanup during app quit",
          { jobId, timeoutMs },
        );
      },
    });
    inpaintingHistoryReleaseSafe = canReleaseInpaintingHistoryAfterQuitCleanup(
      job.kind,
      cleanup,
    );
    if (!inpaintingHistoryReleaseSafe) {
      logWarn(
        cleanupReason === "fatal-incident"
          ? "Skipping inpainting history release because the active job did not settle during fatal shutdown"
          : "Skipping inpainting history release because the active job did not settle before quit",
        { jobId: job.id },
      );
    }
  }

  await cleanupManagedOperation(operations, updateProgress, cleanupReason);

  updateProgress({
    stage: "library-mutation-cleanup",
    ...(job ? { jobId: job.id, jobKind: job.kind } : {}),
  });
  await waitForLibraryMutations();

  updateProgress({
    stage: "runtime-resource-disposal",
    ...(job ? { jobId: job.id, jobKind: job.kind } : {}),
  });
  await disposeRuntimeResources({
    disposeInpainting,
    disposeTranslation,
    logError,
    cleanupReason,
  });

  if (inpaintingHistoryReleaseSafe) {
    updateProgress({
      stage: "inpainting-history-release",
      ...(job ? { jobId: job.id, jobKind: job.kind } : {}),
    });
    try {
      await releaseInpaintingHistory();
    } catch (error) {
      logError(
        cleanupReason === "fatal-incident"
          ? "Failed to release inpainting revision history during fatal shutdown"
          : "Failed to release inpainting revision history during app quit",
        error,
      );
    }
  }
}

function cancelStartupMaintenanceSafely(
  cancelStartupMaintenance: () => void,
  logError: AppQuitCleanupLogger,
  cleanupReason: AppTerminalCleanupReason,
): void {
  try {
    cancelStartupMaintenance();
  } catch (error) {
    logError(
      cleanupReason === "fatal-incident"
        ? "Failed to cancel startup maintenance during fatal shutdown"
        : "Failed to cancel startup maintenance during app quit",
      error,
    );
  }
}

async function cleanupManagedOperation(
  operations: AppQuitCleanupOperations,
  updateProgress: (progress: AppQuitCleanupProgress) => void,
  cleanupReason: AppTerminalCleanupReason,
): Promise<void> {
  const operation = operations.current;
  if (!operation) {
    return;
  }
  if (cleanupReason === "app-quit" && !operation.blocksQuit) {
    return;
  }
  updateProgress({
    stage: "managed-operation-cleanup",
    operationId: operation.id,
    operationKind: operation.kind,
  });
  await operations.abortCurrentAndWait(cleanupReason);
}

async function disposeRuntimeResources({
  disposeInpainting,
  disposeTranslation,
  logError,
  cleanupReason,
}: {
  disposeInpainting: () => Promise<unknown>;
  disposeTranslation: () => Promise<unknown>;
  logError: AppQuitCleanupLogger;
  cleanupReason: AppTerminalCleanupReason;
}): Promise<void> {
  const disposalResults = await Promise.allSettled([
    Promise.resolve().then(disposeInpainting),
    Promise.resolve().then(disposeTranslation),
  ]);
  for (const [index, result] of disposalResults.entries()) {
    if (result.status === "rejected") {
      logError(
        cleanupReason === "fatal-incident"
          ? "Runtime resource disposal failed during fatal shutdown"
          : "Runtime resource disposal failed during app quit",
        {
          resource: index === 0 ? "inpainting-engines" : "translation-runtime",
          error: result.reason,
        },
      );
    }
  }
}
