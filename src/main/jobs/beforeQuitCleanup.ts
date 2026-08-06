import type { ActiveJob, ActiveJobStore } from "./activeJob";

export const BEFORE_QUIT_CLEANUP_TIMEOUT_MS = 5000;

type BeforeQuitCleanupOptions = {
  job: ActiveJob;
  jobs: Pick<ActiveJobStore, "clearIfCurrent" | "runCleanup">;
  warnTimedOut: (jobId: string, timeoutMs: number) => void;
  timeoutMs?: number;
  scheduleTimeout?: (
    callback: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearScheduledTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
};

export type BeforeQuitCleanupResult = {
  timedOut: boolean;
};

export function canReleaseInpaintingHistoryAfterQuitCleanup(
  jobKind: ActiveJob["kind"],
  result: BeforeQuitCleanupResult,
): boolean {
  return jobKind !== "inpainting" || !result.timedOut;
}

export async function finishBeforeQuitCleanup({
  job,
  jobs,
  warnTimedOut,
  timeoutMs = BEFORE_QUIT_CLEANUP_TIMEOUT_MS,
  scheduleTimeout = setTimeout,
  clearScheduledTimeout = clearTimeout,
}: BeforeQuitCleanupOptions): Promise<BeforeQuitCleanupResult> {
  job.abortController.abort();

  const cleanup = jobs.runCleanup(job, "before-quit");
  const timedOut = await waitForCleanupDeadline(
    cleanup,
    timeoutMs,
    scheduleTimeout,
    clearScheduledTimeout,
  );

  if (!timedOut) {
    jobs.clearIfCurrent(job.id);
    return { timedOut: false };
  }

  warnTimedOut(job.id, timeoutMs);

  const clearAfterSettlement = () => {
    jobs.clearIfCurrent(job.id);
  };

  void cleanup.then(clearAfterSettlement, clearAfterSettlement);

  return { timedOut: true };
}

function waitForCleanupDeadline(
  cleanup: Promise<void>,
  timeoutMs: number,
  scheduleTimeout: (
    callback: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>,
  clearScheduledTimeout: (timer: ReturnType<typeof setTimeout>) => void,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;

    const timer = scheduleTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(true);
    }, timeoutMs);

    cleanup.then(
      () => {
        if (settled) {
          return;
        }
        settled = true;
        clearScheduledTimeout(timer);
        resolve(false);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearScheduledTimeout(timer);
        reject(error);
      },
    );
  });
}
