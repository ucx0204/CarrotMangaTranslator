import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveJob } from "../src/main/jobs/activeJob";
import { BEFORE_QUIT_CLEANUP_TIMEOUT_MS } from "../src/main/jobs/beforeQuitCleanup";
import { runMainWindowCloseCleanup } from "../src/main/mainWindowCloseCleanup";

afterEach(() => {
  vi.useRealTimers();
});

describe("main-window close cleanup", () => {
  it("cleans job, operation, mutations, and runtimes in order", async () => {
    const events: string[] = [];
    const job = makeJob();
    job.abortController.signal.addEventListener("abort", () => {
      events.push("job-abort");
    });

    await runMainWindowCloseCleanup({
      jobs: {
        current: job,
        runCleanup: vi.fn(async (_job, reason) => {
          events.push(`job-cleanup:${reason}`);
        }),
        clearIfCurrent: vi.fn(() => events.push("job-clear")),
      },
      operations: {
        current: makeOperation(false),
        abortCurrentAndWait: vi.fn(async (reason) => {
          events.push(`operation-cleanup:${reason}`);
          return null;
        }),
      },
      waitForLibraryMutations: vi.fn(async () => {
        events.push("mutation-idle");
      }),
      disposeInpainting: vi.fn(async () => {
        events.push("dispose-inpainting");
      }),
      disposeTranslation: vi.fn(async () => {
        events.push("dispose-translation");
      }),
      logError: vi.fn(),
      logWarn: vi.fn(),
    });

    expect(events).toEqual([
      "job-abort",
      "job-cleanup:main-window-closed",
      "job-clear",
      "operation-cleanup:main-window-closed",
      "mutation-idle",
      "dispose-inpainting",
      "dispose-translation",
    ]);
  });

  it("cleans a current operation regardless of blocksQuit", async () => {
    const abortCurrentAndWait = vi.fn(async () => null);
    await runMainWindowCloseCleanup({
      jobs: idleJobs(),
      operations: {
        current: makeOperation(false),
        abortCurrentAndWait,
      },
      waitForLibraryMutations: vi.fn(async () => undefined),
      disposeInpainting: vi.fn(async () => undefined),
      disposeTranslation: vi.fn(async () => undefined),
      logError: vi.fn(),
      logWarn: vi.fn(),
    });

    expect(abortCurrentAndWait).toHaveBeenCalledWith("main-window-closed");
  });

  it("runs both disposals, logs individual failures, and rejects cleanup", async () => {
    const failure = new Error("inpainting disposal failed");
    const disposeTranslation = vi.fn(async () => undefined);
    const logError = vi.fn();

    await expect(
      runMainWindowCloseCleanup({
        jobs: idleJobs(),
        operations: idleOperations(),
        waitForLibraryMutations: vi.fn(async () => undefined),
        disposeInpainting: vi.fn(async () => {
          throw failure;
        }),
        disposeTranslation,
        logError,
        logWarn: vi.fn(),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "AggregateError",
        errors: [failure],
      }),
    );

    expect(disposeTranslation).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      "Runtime resource disposal failed after main window close",
      {
        resource: "inpainting-engines",
        error: failure,
      },
    );
  });

  it("keeps a timed-out job active until its cleanup settles", async () => {
    vi.useFakeTimers();
    const job = makeJob();
    const cleanup = createDeferred<void>();
    const clearIfCurrent = vi.fn();
    const logWarn = vi.fn();
    const closing = runMainWindowCloseCleanup({
      jobs: {
        current: job,
        runCleanup: vi.fn(() => cleanup.promise),
        clearIfCurrent,
      },
      operations: idleOperations(),
      waitForLibraryMutations: vi.fn(async () => undefined),
      disposeInpainting: vi.fn(async () => undefined),
      disposeTranslation: vi.fn(async () => undefined),
      logError: vi.fn(),
      logWarn,
    });

    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(BEFORE_QUIT_CLEANUP_TIMEOUT_MS);
    expect(closed).toBe(false);
    expect(clearIfCurrent).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      "Timed out waiting for active job cleanup after the main window closed",
      {
        jobId: job.id,
        timeoutMs: BEFORE_QUIT_CLEANUP_TIMEOUT_MS,
      },
    );

    cleanup.resolve(undefined);
    await closing;
    expect(closed).toBe(true);
    expect(clearIfCurrent).toHaveBeenCalledWith(job.id);
  });
});

function makeJob(): ActiveJob {
  return {
    id: "job-1",
    kind: "gemma-analysis",
    abortController: new AbortController(),
  };
}

function makeOperation(blocksQuit: boolean) {
  return {
    id: "operation-1",
    kind: "model-test" as const,
    mutatesLibrary: false,
    blocksQuit,
    startedAt: 1,
  };
}

function idleJobs() {
  return {
    current: null,
    clearIfCurrent: vi.fn(),
    runCleanup: vi.fn(async () => undefined),
  };
}

function idleOperations() {
  return {
    current: null,
    abortCurrentAndWait: vi.fn(async () => null),
  };
}

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
