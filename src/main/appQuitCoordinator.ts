export const APP_QUIT_HARD_DEADLINE_MS = 15_000;
export const APP_QUIT_FORCE_EXIT_CODE = 0;

type AppQuitCleanupStage =
  | "starting"
  | "startup-maintenance-cancel"
  | "active-job-cleanup"
  | "runtime-resource-disposal"
  | "inpainting-history-release"
  | "electron-quit";

export type AppQuitCleanupProgress = {
  stage: AppQuitCleanupStage;
  jobId?: string;
  jobKind?: string;
};

type AppQuitForcedExitReason =
  | "hard-deadline"
  | "graceful-quit-failed"
  | "watchdog-scheduling-failed";

type AppQuitForcedExitDetail = {
  reason: AppQuitForcedExitReason;
  hardDeadlineMs: number;
  elapsedMs: number;
  stage: AppQuitCleanupStage;
  jobId?: string;
  jobKind?: string;
};

export type AppQuitCoordinatorRuntime = {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  gracefulQuit: () => void;
  forceExit: (code: number) => void;
  reportCleanupFailure: (
    error: unknown,
    progress: Readonly<AppQuitCleanupProgress>,
  ) => void;
  reportForcedExit: (detail: Readonly<AppQuitForcedExitDetail>) => void;
};

export type AppQuitAttempt = {
  completion: Promise<void>;
};

export function beginBoundedAppQuit({
  runCleanup,
  runtime,
  hardDeadlineMs = APP_QUIT_HARD_DEADLINE_MS,
}: {
  runCleanup: (
    updateProgress: (progress: AppQuitCleanupProgress) => void,
  ) => Promise<void>;
  runtime: AppQuitCoordinatorRuntime;
  hardDeadlineMs?: number;
}): AppQuitAttempt {
  const normalizedDeadline = normalizeHardDeadlineMs(hardDeadlineMs);
  const startedAt = runtime.now();

  let progress: AppQuitCleanupProgress = { stage: "starting" };
  let forceExitTriggered = false;

  const updateProgress = (next: AppQuitCleanupProgress): void => {
    progress = sanitizeProgress(next);
  };

  const reportCleanupFailureSafely = (error: unknown): void => {
    try {
      runtime.reportCleanupFailure(error, { ...progress });
    } catch (reportError) {
      console.error("Failed to report app quit cleanup failure", reportError);
    }
  };

  const forceExit = (reason: AppQuitForcedExitReason): void => {
    if (forceExitTriggered) {
      return;
    }
    forceExitTriggered = true;

    const detail: AppQuitForcedExitDetail = {
      reason,
      hardDeadlineMs: normalizedDeadline,
      elapsedMs: Math.max(0, runtime.now() - startedAt),
      ...progress,
    };

    try {
      runtime.reportForcedExit(detail);
    } catch (reportError) {
      console.error("Failed to report forced app exit", reportError);
    }

    try {
      runtime.forceExit(APP_QUIT_FORCE_EXIT_CODE);
    } catch (forceError) {
      console.error("Forced app exit failed", forceError);
    }
  };

  try {
    runtime.schedule(() => forceExit("hard-deadline"), normalizedDeadline);
  } catch (error) {
    reportCleanupFailureSafely(error);
    forceExit("watchdog-scheduling-failed");
  }

  const completion = Promise.resolve()
    .then(() => runCleanup(updateProgress))
    .catch((error) => {
      reportCleanupFailureSafely(error);
    })
    .then(() => {
      if (forceExitTriggered) {
        return;
      }

      updateProgress({ ...progress, stage: "electron-quit" });
      try {
        runtime.gracefulQuit();
      } catch (error) {
        reportCleanupFailureSafely(error);
        forceExit("graceful-quit-failed");
      }
    });

  return { completion };
}

function normalizeHardDeadlineMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("App quit hard deadline must be a positive finite number.");
  }
  return Math.max(1, Math.floor(value));
}

function sanitizeProgress(
  progress: AppQuitCleanupProgress,
): AppQuitCleanupProgress {
  return {
    stage: progress.stage,
    ...(progress.jobId === undefined ? {} : { jobId: progress.jobId }),
    ...(progress.jobKind === undefined ? {} : { jobKind: progress.jobKind }),
  };
}
