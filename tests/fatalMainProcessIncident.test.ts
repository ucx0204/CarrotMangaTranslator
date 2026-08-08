import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppActivityClosedError,
  AppActivityGate,
} from "../src/main/appActivityGate";
import {
  FATAL_MAIN_PROCESS_CLEANUP_HARD_DEADLINE_MS,
  FATAL_MAIN_PROCESS_EXIT_CODE,
  FatalMainProcessIncidentCoordinator,
  type FatalMainProcessIncidentRuntime,
} from "../src/main/fatalMainProcessIncident";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fatal main-process incident coordinator", () => {
  it("closes intake before reporting and exits after successful cleanup", async () => {
    const events: string[] = [];
    const runtime = makeRuntime({
      setExitCode: vi.fn((code) => events.push(`exit-code:${code}`)),
      schedule: vi.fn((callback, delayMs) => {
        events.push(`schedule:${delayMs}`);
        return setTimeout(callback, delayMs);
      }),
      clearScheduled: vi.fn((handle) => {
        events.push("clear-watchdog");
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      }),
      reportForcedExit: vi.fn((detail) =>
        events.push(`report-exit:${detail.reason}`),
      ),
      forceExit: vi.fn((code) => events.push(`force-exit:${code}`)),
    });
    const coordinator = new FatalMainProcessIncidentCoordinator();

    const attempt = coordinator.begin({
      source: "uncaught-exception",
      reason: new Error("fatal"),
      closeIntake: () => events.push("close-intake"),
      notifyIncident: () => events.push("notify"),
      isolateNormalWindows: () => events.push("isolate"),
      runCleanup: async () => {
        events.push("cleanup");
      },
      runtime,
    });

    expect(coordinator.isHandling).toBe(true);
    expect(events).toEqual([
      `exit-code:${FATAL_MAIN_PROCESS_EXIT_CODE}`,
      "close-intake",
      "notify",
      "isolate",
      `schedule:${FATAL_MAIN_PROCESS_CLEANUP_HARD_DEADLINE_MS}`,
    ]);

    await attempt.completion;
    expect(events).toEqual([
      `exit-code:${FATAL_MAIN_PROCESS_EXIT_CODE}`,
      "close-intake",
      "notify",
      "isolate",
      `schedule:${FATAL_MAIN_PROCESS_CLEANUP_HARD_DEADLINE_MS}`,
      "cleanup",
      "clear-watchdog",
      "report-exit:cleanup-complete",
      `force-exit:${FATAL_MAIN_PROCESS_EXIT_CODE}`,
    ]);
  });

  it("forces exit at the hard deadline and ignores late cleanup completion", async () => {
    const cleanup = createDeferred<void>();
    const runtime = makeRuntime();
    const coordinator = new FatalMainProcessIncidentCoordinator();
    const attempt = coordinator.begin({
      source: "unhandled-rejection",
      reason: "fatal",
      closeIntake: vi.fn(),
      notifyIncident: vi.fn(),
      isolateNormalWindows: vi.fn(),
      runCleanup: () => cleanup.promise,
      runtime,
    });

    await vi.advanceTimersByTimeAsync(
      FATAL_MAIN_PROCESS_CLEANUP_HARD_DEADLINE_MS - 1,
    );
    expect(runtime.forceExit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await attempt.completion;
    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "hard-deadline",
        source: "unhandled-rejection",
        deadlineMs: FATAL_MAIN_PROCESS_CLEANUP_HARD_DEADLINE_MS,
      }),
    );
    expect(runtime.forceExit).toHaveBeenCalledTimes(1);

    cleanup.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.forceExit).toHaveBeenCalledTimes(1);
  });

  it("reports cleanup rejection and still exits with code 1", async () => {
    const failure = new Error("cleanup failed");
    const runtime = makeRuntime();
    const coordinator = new FatalMainProcessIncidentCoordinator();
    const attempt = coordinator.begin({
      source: "uncaught-exception",
      reason: failure,
      closeIntake: vi.fn(),
      notifyIncident: vi.fn(),
      isolateNormalWindows: vi.fn(),
      runCleanup: async () => {
        throw failure;
      },
      runtime,
    });

    await expect(attempt.completion).resolves.toBeUndefined();
    expect(runtime.reportCleanupFailure).toHaveBeenCalledWith(failure);
    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cleanup-failed" }),
    );
    expect(runtime.forceExit).toHaveBeenCalledWith(
      FATAL_MAIN_PROCESS_EXIT_CODE,
    );
  });

  it.each(["notify", "isolate"] as const)(
    "continues cleanup and exit when %s throws",
    async (throwingCallback) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const runtime = makeRuntime();
      const cleanup = vi.fn(async () => undefined);
      const coordinator = new FatalMainProcessIncidentCoordinator();
      const failure = () => {
        throw new Error(`${throwingCallback} failed`);
      };

      const attempt = coordinator.begin({
        source: "uncaught-exception",
        reason: "fatal",
        closeIntake: vi.fn(),
        notifyIncident: throwingCallback === "notify" ? failure : vi.fn(),
        isolateNormalWindows:
          throwingCallback === "isolate" ? failure : vi.fn(),
        runCleanup: cleanup,
        runtime,
      });

      await expect(attempt.completion).resolves.toBeUndefined();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(runtime.forceExit).toHaveBeenCalledWith(
        FATAL_MAIN_PROCESS_EXIT_CODE,
      );
    },
  );

  it("forces exit even when failure and forced-exit reporters throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime({
      reportCleanupFailure: vi.fn(() => {
        throw new Error("cleanup reporter failed");
      }),
      reportForcedExit: vi.fn(() => {
        throw new Error("exit reporter failed");
      }),
    });
    const coordinator = new FatalMainProcessIncidentCoordinator();
    const attempt = coordinator.begin({
      source: "uncaught-exception",
      reason: "fatal",
      closeIntake: vi.fn(),
      notifyIncident: vi.fn(),
      isolateNormalWindows: vi.fn(),
      runCleanup: async () => {
        throw new Error("cleanup failed");
      },
      runtime,
    });

    await expect(attempt.completion).resolves.toBeUndefined();
    expect(runtime.forceExit).toHaveBeenCalledWith(
      FATAL_MAIN_PROCESS_EXIT_CODE,
    );
  });

  it("exits immediately without cleanup when watchdog scheduling fails", async () => {
    const schedulingFailure = new Error("schedule failed");
    const runtime = makeRuntime({
      schedule: vi.fn(() => {
        throw schedulingFailure;
      }),
    });
    const cleanup = vi.fn(async () => undefined);
    const coordinator = new FatalMainProcessIncidentCoordinator();
    const attempt = coordinator.begin({
      source: "uncaught-exception",
      reason: "fatal",
      closeIntake: vi.fn(),
      notifyIncident: vi.fn(),
      isolateNormalWindows: vi.fn(),
      runCleanup: cleanup,
      runtime,
    });

    await attempt.completion;
    expect(cleanup).not.toHaveBeenCalled();
    expect(runtime.reportCleanupFailure).toHaveBeenCalledWith(
      schedulingFailure,
    );
    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "watchdog-scheduling-failed" }),
    );
  });

  it("permanently closes activity and mutation intake before cleanup starts", async () => {
    vi.resetModules();
    const { libraryMutationCoordinator } =
      await import("../src/main/libraryStore/libraryMutationCoordinator");
    const activityGate = new AppActivityGate();
    const cleanup = createDeferred<void>();
    const coordinator = new FatalMainProcessIncidentCoordinator();
    const attempt = coordinator.begin({
      source: "uncaught-exception",
      reason: "fatal",
      closeIntake: () => {
        activityGate.closeToNewActivities();
        libraryMutationCoordinator.closeToNewMutations();
      },
      notifyIncident: vi.fn(),
      isolateNormalWindows: vi.fn(),
      runCleanup: () => cleanup.promise,
      runtime: makeRuntime(),
    });

    expect(() =>
      activityGate.acquire({
        id: "late-job",
        category: "job",
        kind: "translation",
        mutatesLibrary: true,
        blocksQuit: true,
      }),
    ).toThrow(AppActivityClosedError);
    expect(() => libraryMutationCoordinator.begin()).toThrow(/종료 중/);

    cleanup.resolve(undefined);
    await attempt.completion;
  });

  it("accelerates exit without starting another cleanup on a second incident", async () => {
    const cleanup = createDeferred<void>();
    const runCleanup = vi.fn(() => cleanup.promise);
    const runtime = makeRuntime();
    const coordinator = new FatalMainProcessIncidentCoordinator();
    const first = coordinator.begin({
      source: "uncaught-exception",
      reason: "first",
      closeIntake: vi.fn(),
      notifyIncident: vi.fn(),
      isolateNormalWindows: vi.fn(),
      runCleanup,
      runtime,
    });
    await Promise.resolve();

    const second = coordinator.begin({
      source: "unhandled-rejection",
      reason: "second",
      closeIntake: vi.fn(),
      notifyIncident: vi.fn(),
      isolateNormalWindows: vi.fn(),
      runCleanup,
      runtime,
    });

    await expect(
      Promise.all([first.completion, second.completion]),
    ).resolves.toEqual([undefined, undefined]);
    expect(runCleanup).toHaveBeenCalledTimes(1);
    expect(runtime.reportSecondaryIncident).toHaveBeenCalledWith(
      "unhandled-rejection",
      "second",
    );
    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "secondary-fatal-incident" }),
    );
    expect(runtime.forceExit).toHaveBeenCalledTimes(1);
  });

  it("falls back to emergency exit when Electron force exit throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sentinel = new Error("process exit sentinel");
    const emergencyExit = vi.fn(() => {
      throw sentinel;
    });
    const runtime = makeRuntime({
      forceExit: vi.fn(() => {
        throw new Error("app.exit failed");
      }),
      emergencyExit,
    });
    const coordinator = new FatalMainProcessIncidentCoordinator();
    const attempt = coordinator.begin({
      source: "uncaught-exception",
      reason: "fatal",
      closeIntake: vi.fn(),
      notifyIncident: vi.fn(),
      isolateNormalWindows: vi.fn(),
      runCleanup: async () => undefined,
      runtime,
    });

    await expect(attempt.completion).resolves.toBeUndefined();
    expect(emergencyExit).toHaveBeenCalledWith(FATAL_MAIN_PROCESS_EXIT_CODE);
  });
});

function makeRuntime(
  overrides: Partial<FatalMainProcessIncidentRuntime> = {},
): FatalMainProcessIncidentRuntime {
  return {
    now: vi.fn(() => Date.now()),
    schedule: vi.fn((callback, delayMs) => setTimeout(callback, delayMs)),
    clearScheduled: vi.fn((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    ),
    setExitCode: vi.fn(),
    forceExit: vi.fn(),
    emergencyExit: vi.fn((code) => process.exit(code)),
    reportCleanupFailure: vi.fn(),
    reportForcedExit: vi.fn(),
    reportSecondaryIncident: vi.fn(),
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
