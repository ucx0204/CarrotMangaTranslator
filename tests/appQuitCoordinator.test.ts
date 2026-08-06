import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_QUIT_FORCE_EXIT_CODE,
  APP_QUIT_HARD_DEADLINE_MS,
  beginBoundedAppQuit,
  type AppQuitCoordinatorRuntime,
} from "../src/main/appQuitCoordinator";
import { BEFORE_QUIT_CLEANUP_TIMEOUT_MS } from "../src/main/jobs/beforeQuitCleanup";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("app quit coordinator", () => {
  it("keeps the production hard deadline above the active-job cleanup timeout", () => {
    expect(APP_QUIT_HARD_DEADLINE_MS).toBeGreaterThan(
      BEFORE_QUIT_CLEANUP_TIMEOUT_MS,
    );
  });

  it("forces exit when cleanup never settles", async () => {
    const cleanup = createDeferred<void>();
    const runtime = makeRuntime();

    beginBoundedAppQuit({
      runCleanup: async (update) => {
        update({
          stage: "runtime-resource-disposal",
          jobId: "job-1",
          jobKind: "inpainting",
        });
        await cleanup.promise;
      },
      runtime,
    });

    await vi.advanceTimersByTimeAsync(APP_QUIT_HARD_DEADLINE_MS - 1);
    expect(runtime.forceExit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "hard-deadline",
        hardDeadlineMs: APP_QUIT_HARD_DEADLINE_MS,
        elapsedMs: APP_QUIT_HARD_DEADLINE_MS,
        stage: "runtime-resource-disposal",
        jobId: "job-1",
        jobKind: "inpainting",
      }),
    );
    expect(runtime.forceExit).toHaveBeenCalledTimes(1);
    expect(runtime.forceExit).toHaveBeenCalledWith(APP_QUIT_FORCE_EXIT_CODE);
    expect(runtime.gracefulQuit).not.toHaveBeenCalled();
  });

  it("requests graceful quit after cleanup completes", async () => {
    const runtime = makeRuntime();
    const attempt = beginBoundedAppQuit({
      runCleanup: async () => undefined,
      runtime,
    });

    await attempt.completion;

    expect(runtime.gracefulQuit).toHaveBeenCalledTimes(1);
    expect(runtime.forceExit).not.toHaveBeenCalled();
  });

  it("keeps the watchdog armed after graceful quit is requested", async () => {
    const runtime = makeRuntime();
    const attempt = beginBoundedAppQuit({
      runCleanup: async () => undefined,
      runtime,
    });

    await attempt.completion;
    expect(runtime.gracefulQuit).toHaveBeenCalledTimes(1);
    expect(runtime.forceExit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(APP_QUIT_HARD_DEADLINE_MS);

    expect(runtime.forceExit).toHaveBeenCalledTimes(1);
    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "hard-deadline",
        stage: "electron-quit",
      }),
    );
  });

  it("does not request graceful quit when cleanup settles after the deadline", async () => {
    const cleanup = createDeferred<void>();
    const runtime = makeRuntime();
    const attempt = beginBoundedAppQuit({
      runCleanup: async () => cleanup.promise,
      runtime,
    });

    await vi.advanceTimersByTimeAsync(APP_QUIT_HARD_DEADLINE_MS);
    expect(runtime.forceExit).toHaveBeenCalledTimes(1);

    cleanup.resolve(undefined);
    await attempt.completion;

    expect(runtime.gracefulQuit).not.toHaveBeenCalled();
    expect(runtime.forceExit).toHaveBeenCalledTimes(1);
  });

  it("reports cleanup rejection and still requests graceful quit", async () => {
    const runtime = makeRuntime();
    const failure = new Error("cleanup failed");
    const attempt = beginBoundedAppQuit({
      runCleanup: async () => {
        throw failure;
      },
      runtime,
    });

    await attempt.completion;

    expect(runtime.reportCleanupFailure).toHaveBeenCalledWith(failure, {
      stage: "starting",
    });
    expect(runtime.gracefulQuit).toHaveBeenCalledTimes(1);
    expect(runtime.forceExit).not.toHaveBeenCalled();
  });

  it("continues when the cleanup failure reporter throws", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const runtime = makeRuntime({
      reportCleanupFailure: vi.fn(() => {
        throw new Error("report failed");
      }),
    });
    const attempt = beginBoundedAppQuit({
      runCleanup: async () => {
        throw new Error("cleanup failed");
      },
      runtime,
    });

    await expect(attempt.completion).resolves.toBeUndefined();

    expect(runtime.gracefulQuit).toHaveBeenCalledTimes(1);
    expect(runtime.forceExit).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("forces exit even when the forced-exit reporter throws", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const cleanup = createDeferred<void>();
    const runtime = makeRuntime({
      reportForcedExit: vi.fn(() => {
        throw new Error("report failed");
      }),
    });

    beginBoundedAppQuit({
      runCleanup: async () => cleanup.promise,
      runtime,
    });

    await vi.advanceTimersByTimeAsync(APP_QUIT_HARD_DEADLINE_MS);

    expect(runtime.forceExit).toHaveBeenCalledTimes(1);
    expect(runtime.forceExit).toHaveBeenCalledWith(APP_QUIT_FORCE_EXIT_CODE);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("forces exit immediately when graceful quit throws", async () => {
    const failure = new Error("quit failed");
    const runtime = makeRuntime({
      gracefulQuit: vi.fn(() => {
        throw failure;
      }),
    });
    const attempt = beginBoundedAppQuit({
      runCleanup: async () => undefined,
      runtime,
    });

    await attempt.completion;

    expect(runtime.reportCleanupFailure).toHaveBeenCalledWith(failure, {
      stage: "electron-quit",
    });
    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "graceful-quit-failed",
        stage: "electron-quit",
      }),
    );
    expect(runtime.forceExit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(APP_QUIT_HARD_DEADLINE_MS);
    expect(runtime.forceExit).toHaveBeenCalledTimes(1);
  });

  it("forces exit immediately when watchdog scheduling fails", async () => {
    const failure = new Error("schedule failed");
    const runtime = makeRuntime({
      schedule: vi.fn(() => {
        throw failure;
      }),
    });
    const runCleanup = vi.fn(async () => undefined);
    const attempt = beginBoundedAppQuit({ runCleanup, runtime });

    expect(runtime.reportCleanupFailure).toHaveBeenCalledWith(failure, {
      stage: "starting",
    });
    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "watchdog-scheduling-failed",
        stage: "starting",
      }),
    );
    expect(runtime.forceExit).toHaveBeenCalledTimes(1);

    await attempt.completion;
    expect(runCleanup).toHaveBeenCalledTimes(1);
    expect(runtime.gracefulQuit).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid hard deadline %s",
    (hardDeadlineMs) => {
      expect(() =>
        beginBoundedAppQuit({
          runCleanup: async () => undefined,
          runtime: makeRuntime(),
          hardDeadlineMs,
        }),
      ).toThrow("App quit hard deadline must be a positive finite number.");
    },
  );
});

function makeRuntime(
  overrides: Partial<AppQuitCoordinatorRuntime> = {},
): AppQuitCoordinatorRuntime {
  return {
    now: vi.fn(() => Date.now()),
    schedule: vi.fn((callback, delayMs) => setTimeout(callback, delayMs)),
    gracefulQuit: vi.fn(),
    forceExit: vi.fn(),
    reportCleanupFailure: vi.fn(),
    reportForcedExit: vi.fn(),
    ...overrides,
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
