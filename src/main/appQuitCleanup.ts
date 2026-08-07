import type { AppOperationRegistry } from "./appOperationRegistry";
import type { AppQuitCleanupProgress } from "./appQuitCoordinator";
import type { ActiveJobStore } from "./jobs/activeJob";
import {
  canReleaseInpaintingHistoryAfterQuitCleanup,
  finishBeforeQuitCleanup,
} from "./jobs/beforeQuitCleanup";

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
  releaseInpaintingHistory,
  updateProgress,
  logError,
  logWarn,
}: {
  jobs: AppQuitCleanupJobs;
  operations: AppQuitCleanupOperations;
  cancelStartupMaintenance: () => void;
  disposeInpainting: () => Promise<unknown>;
  disposeTranslation: () => Promise<unknown>;
  releaseInpaintingHistory: () => Promise<unknown>;
  updateProgress: (progress: AppQuitCleanupProgress) => void;
  logError: AppQuitCleanupLogger;
  logWarn: AppQuitCleanupLogger;
}): Promise<void> {
  updateProgress({ stage: "startup-maintenance-cancel" });
  cancelStartupMaintenanceSafely(cancelStartupMaintenance, logError);

  let inpaintingHistoryReleaseSafe = true;
  const job = jobs.current;

  if (job) {
    updateProgress({
      stage: "active-job-cleanup",
      jobId: job.id,
      jobKind: job.kind,
    });
    const cleanup = await finishBeforeQuitCleanup({
      job,
      jobs,
      warnTimedOut: (jobId, timeoutMs) => {
        logWarn("Timed out waiting for active job cleanup during app quit", {
          jobId,
          timeoutMs,
        });
      },
    });
    inpaintingHistoryReleaseSafe = canReleaseInpaintingHistoryAfterQuitCleanup(
      job.kind,
      cleanup,
    );
    if (!inpaintingHistoryReleaseSafe) {
      logWarn(
        "Skipping inpainting history release because the active job did not settle before quit",
        { jobId: job.id },
      );
    }
  }

  await cleanupManagedOperation(operations, updateProgress);

  updateProgress({
    stage: "runtime-resource-disposal",
    ...(job ? { jobId: job.id, jobKind: job.kind } : {}),
  });
  await disposeRuntimeResources({
    disposeInpainting,
    disposeTranslation,
    logError,
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
        "Failed to release inpainting revision history during app quit",
        error,
      );
    }
  }
}

function cancelStartupMaintenanceSafely(
  cancelStartupMaintenance: () => void,
  logError: AppQuitCleanupLogger,
): void {
  try {
    cancelStartupMaintenance();
  } catch (error) {
    logError("Failed to cancel startup maintenance during app quit", error);
  }
}

async function cleanupManagedOperation(
  operations: AppQuitCleanupOperations,
  updateProgress: (progress: AppQuitCleanupProgress) => void,
): Promise<void> {
  const operation = operations.current;
  if (!operation?.blocksQuit) {
    return;
  }
  updateProgress({
    stage: "managed-operation-cleanup",
    operationId: operation.id,
    operationKind: operation.kind,
  });
  await operations.abortCurrentAndWait("app-quit");
}

async function disposeRuntimeResources({
  disposeInpainting,
  disposeTranslation,
  logError,
}: {
  disposeInpainting: () => Promise<unknown>;
  disposeTranslation: () => Promise<unknown>;
  logError: AppQuitCleanupLogger;
}): Promise<void> {
  const disposalResults = await Promise.allSettled([
    Promise.resolve().then(disposeInpainting),
    Promise.resolve().then(disposeTranslation),
  ]);
  for (const [index, result] of disposalResults.entries()) {
    if (result.status === "rejected") {
      logError("Runtime resource disposal failed during app quit", {
        resource: index === 0 ? "inpainting-engines" : "translation-runtime",
        error: result.reason,
      });
    }
  }
}
