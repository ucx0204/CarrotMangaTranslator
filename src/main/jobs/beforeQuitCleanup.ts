import type { ActiveJob, ActiveJobStore } from "./activeJob";

export const BEFORE_QUIT_CLEANUP_TIMEOUT_MS = 5000;

type BeforeQuitCleanupOptions = {
  job: ActiveJob;
  jobs: Pick<ActiveJobStore, "clearIfCurrent" | "runCleanup">;
  quit: () => void;
  warnTimedOut: (jobId: string, timeoutMs: number) => void;
  timeoutMs?: number;
  wait?: (timeoutMs: number) => Promise<void>;
};

export async function finishBeforeQuitCleanup({
  job,
  jobs,
  quit,
  warnTimedOut,
  timeoutMs = BEFORE_QUIT_CLEANUP_TIMEOUT_MS,
  wait = delay,
}: BeforeQuitCleanupOptions): Promise<void> {
  job.abortController.abort();
  const timedOut = await Promise.race([
    jobs.runCleanup(job, "before-quit").then(() => false),
    wait(timeoutMs).then(() => true),
  ]);
  if (timedOut) {
    warnTimedOut(job.id, timeoutMs);
  }
  jobs.clearIfCurrent(job.id);
  quit();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
