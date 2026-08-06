import { afterEach, describe, expect, it, vi } from "vitest";
import { runAppQuitCleanup } from "../src/main/appQuitCleanup";
import type { AppQuitCleanupProgress } from "../src/main/appQuitCoordinator";
import type { ActiveJob } from "../src/main/jobs/activeJob";
import { BEFORE_QUIT_CLEANUP_TIMEOUT_MS } from "../src/main/jobs/beforeQuitCleanup";

afterEach(() => {
  vi.useRealTimers();
});

describe("app quit cleanup orchestration", () => {
  it("continues through cancellation and disposal failures before releasing history", async () => {
    const cancelFailure = new Error("cancel failed");
    const disposalFailure = new Error("dispose failed");
    const progress: AppQuitCleanupProgress[] = [];
    const disposeInpainting = vi.fn(async () => {
      throw disposalFailure;
    });
    const disposeTranslation = vi.fn(async () => undefined);
    const releaseInpaintingHistory = vi.fn(async () => 0);
    const logError = vi.fn();

    await runAppQuitCleanup({
      jobs: {
        current: null,
        clearIfCurrent: vi.fn(),
        runCleanup: vi.fn(async () => undefined),
      },
      cancelStartupMaintenance: () => {
        throw cancelFailure;
      },
      disposeInpainting,
      disposeTranslation,
      releaseInpaintingHistory,
      updateProgress: (next) => progress.push(next),
      logError,
      logWarn: vi.fn(),
    });

    expect(progress).toEqual([
      { stage: "startup-maintenance-cancel" },
      { stage: "runtime-resource-disposal" },
      { stage: "inpainting-history-release" },
    ]);
    expect(disposeInpainting).toHaveBeenCalledTimes(1);
    expect(disposeTranslation).toHaveBeenCalledTimes(1);
    expect(releaseInpaintingHistory).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      "Failed to cancel startup maintenance during app quit",
      cancelFailure,
    );
    expect(logError).toHaveBeenCalledWith(
      "Runtime resource disposal failed during app quit",
      {
        resource: "inpainting-engines",
        error: disposalFailure,
      },
    );
  });

  it("skips history release after an inpainting cleanup timeout and late-clears the job", async () => {
    vi.useFakeTimers();
    const cleanupGate = createDeferred<void>();
    const job: ActiveJob = {
      id: "job-inpainting",
      kind: "inpainting",
      abortController: new AbortController(),
    };
    const clearIfCurrent = vi.fn();
    const releaseInpaintingHistory = vi.fn(async () => 0);
    const logWarn = vi.fn();
    const progress: AppQuitCleanupProgress[] = [];

    const cleanup = runAppQuitCleanup({
      jobs: {
        current: job,
        clearIfCurrent,
        runCleanup: vi.fn(() => cleanupGate.promise),
      },
      cancelStartupMaintenance: vi.fn(),
      disposeInpainting: vi.fn(async () => undefined),
      disposeTranslation: vi.fn(async () => undefined),
      releaseInpaintingHistory,
      updateProgress: (next) => progress.push(next),
      logError: vi.fn(),
      logWarn,
    });

    await vi.advanceTimersByTimeAsync(BEFORE_QUIT_CLEANUP_TIMEOUT_MS);
    await cleanup;

    expect(job.abortController.signal.aborted).toBe(true);
    expect(clearIfCurrent).not.toHaveBeenCalled();
    expect(releaseInpaintingHistory).not.toHaveBeenCalled();
    expect(progress).toEqual([
      { stage: "startup-maintenance-cancel" },
      {
        stage: "active-job-cleanup",
        jobId: job.id,
        jobKind: job.kind,
      },
      {
        stage: "runtime-resource-disposal",
        jobId: job.id,
        jobKind: job.kind,
      },
    ]);
    expect(logWarn).toHaveBeenCalledWith(
      "Timed out waiting for active job cleanup during app quit",
      {
        jobId: job.id,
        timeoutMs: BEFORE_QUIT_CLEANUP_TIMEOUT_MS,
      },
    );
    expect(logWarn).toHaveBeenCalledWith(
      "Skipping inpainting history release because the active job did not settle before quit",
      { jobId: job.id },
    );

    cleanupGate.resolve(undefined);
    await Promise.resolve();

    expect(clearIfCurrent).toHaveBeenCalledTimes(1);
    expect(clearIfCurrent).toHaveBeenCalledWith(job.id);
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Failed to initialize deferred promise.");
  }
  return { promise, resolve: resolvePromise };
}
