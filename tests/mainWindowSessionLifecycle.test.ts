import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppActivityClosedError,
  AppActivityGate,
} from "../src/main/appActivityGate";
import {
  MAIN_WINDOW_CLOSE_CLEANUP_HARD_DEADLINE_MS,
  MAIN_WINDOW_CLOSE_FAILURE_EXIT_CODE,
  MainWindowSessionLifecycle,
  type MainWindowSessionLifecycleRuntime,
} from "../src/main/mainWindowSessionLifecycle";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("main-window session lifecycle", () => {
  it("suspends synchronously and releases in order after Darwin cleanup", async () => {
    const events: string[] = [];
    const lifecycle = new MainWindowSessionLifecycle({
      suspendActivities: () => {
        events.push("suspend-activity");
        return { release: () => events.push("release-activity") };
      },
      suspendMutations: () => {
        events.push("suspend-mutation");
        return { release: () => events.push("release-mutation") };
      },
      runCleanup: async () => {
        events.push("cleanup");
      },
      openWindow: () => events.push("open-window"),
      runtime: makeRuntime({
        schedule: vi.fn((callback, delayMs) => {
          events.push(`schedule:${delayMs}`);
          return setTimeout(callback, delayMs);
        }),
        clearScheduled: vi.fn((handle) => {
          events.push("clear-watchdog");
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        }),
      }),
    });

    lifecycle.handleMainWindowClosed();
    expect(lifecycle.isCleanupInFlight).toBe(true);
    expect(events).toEqual([
      "suspend-activity",
      "suspend-mutation",
      `schedule:${MAIN_WINDOW_CLOSE_CLEANUP_HARD_DEADLINE_MS}`,
    ]);

    await lifecycle.waitForCleanup();
    expect(lifecycle.isCleanupInFlight).toBe(false);
    expect(events).toEqual([
      "suspend-activity",
      "suspend-mutation",
      `schedule:${MAIN_WINDOW_CLOSE_CLEANUP_HARD_DEADLINE_MS}`,
      "cleanup",
      "clear-watchdog",
      "release-mutation",
      "release-activity",
    ]);
  });

  it("coalesces repeated reopen requests until cleanup succeeds", async () => {
    const cleanup = createDeferred<void>();
    const openWindow = vi.fn();
    const lifecycle = makeLifecycle({
      runCleanup: () => cleanup.promise,
      openWindow,
    });

    lifecycle.handleMainWindowClosed();
    const waiting = lifecycle.waitForCleanup();
    lifecycle.requestWindowOpen();
    lifecycle.requestWindowOpen();
    lifecycle.requestWindowOpen();
    expect(openWindow).not.toHaveBeenCalled();

    cleanup.resolve(undefined);
    await waiting;
    expect(openWindow).toHaveBeenCalledTimes(1);
  });

  it("drops a pending reopen request on terminal mode", async () => {
    const cleanup = createDeferred<void>();
    const openWindow = vi.fn();
    const lifecycle = makeLifecycle({
      runCleanup: () => cleanup.promise,
      openWindow,
    });

    lifecycle.handleMainWindowClosed();
    const waiting = lifecycle.waitForCleanup();
    lifecycle.requestWindowOpen();
    lifecycle.enterTerminalMode();
    cleanup.resolve(undefined);
    await waiting;

    expect(openWindow).not.toHaveBeenCalled();
    lifecycle.requestWindowOpen();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens immediately when requested after cleanup", async () => {
    const openWindow = vi.fn();
    const lifecycle = makeLifecycle({ openWindow });

    lifecycle.handleMainWindowClosed();
    await lifecycle.waitForCleanup();
    expect(openWindow).not.toHaveBeenCalled();

    lifecycle.requestWindowOpen();
    expect(openWindow).toHaveBeenCalledTimes(1);
  });

  it.each(["win32", "linux"] as const)(
    "does not start close cleanup on %s",
    (platform) => {
      const suspendActivities = vi.fn(() => ({ release: vi.fn() }));
      const suspendMutations = vi.fn(() => ({ release: vi.fn() }));
      const runCleanup = vi.fn(async () => undefined);
      const openWindow = vi.fn();
      const lifecycle = new MainWindowSessionLifecycle({
        suspendActivities,
        suspendMutations,
        runCleanup,
        openWindow,
        runtime: makeRuntime({ platform }),
      });

      lifecycle.handleMainWindowClosed();
      expect(suspendActivities).not.toHaveBeenCalled();
      expect(suspendMutations).not.toHaveBeenCalled();
      expect(runCleanup).not.toHaveBeenCalled();

      lifecycle.requestWindowOpen();
      expect(openWindow).toHaveBeenCalledTimes(1);
    },
  );

  it("forces abnormal exit at the hard deadline without releasing suspensions", async () => {
    const activityRelease = vi.fn();
    const mutationRelease = vi.fn();
    const runtime = makeRuntime();
    const lifecycle = makeLifecycle({
      suspendActivities: () => ({ release: activityRelease }),
      suspendMutations: () => ({ release: mutationRelease }),
      runCleanup: async () => new Promise<void>(() => {}),
      runtime,
    });

    lifecycle.handleMainWindowClosed();
    const waiting = lifecycle.waitForCleanup();
    await vi.advanceTimersByTimeAsync(
      MAIN_WINDOW_CLOSE_CLEANUP_HARD_DEADLINE_MS,
    );
    await waiting;

    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "hard-deadline",
        deadlineMs: MAIN_WINDOW_CLOSE_CLEANUP_HARD_DEADLINE_MS,
      }),
    );
    expect(runtime.forceExit).toHaveBeenCalledWith(
      MAIN_WINDOW_CLOSE_FAILURE_EXIT_CODE,
    );
    expect(activityRelease).not.toHaveBeenCalled();
    expect(mutationRelease).not.toHaveBeenCalled();
  });

  it("forces abnormal exit when cleanup rejects", async () => {
    const failure = new Error("cleanup failed");
    const openWindow = vi.fn();
    const runtime = makeRuntime();
    const lifecycle = makeLifecycle({
      runCleanup: async () => {
        throw failure;
      },
      openWindow,
      runtime,
    });

    lifecycle.handleMainWindowClosed();
    await lifecycle.waitForCleanup();

    expect(runtime.reportCleanupFailure).toHaveBeenCalledWith(failure);
    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cleanup-failed" }),
    );
    expect(runtime.forceExit).toHaveBeenCalledWith(
      MAIN_WINDOW_CLOSE_FAILURE_EXIT_CODE,
    );
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("exits immediately without cleanup when watchdog scheduling fails", async () => {
    const schedulingFailure = new Error("schedule failed");
    const runCleanup = vi.fn(async () => undefined);
    const activityRelease = vi.fn();
    const mutationRelease = vi.fn();
    const runtime = makeRuntime({
      schedule: vi.fn(() => {
        throw schedulingFailure;
      }),
    });
    const lifecycle = makeLifecycle({
      suspendActivities: () => ({ release: activityRelease }),
      suspendMutations: () => ({ release: mutationRelease }),
      runCleanup,
      runtime,
    });

    lifecycle.handleMainWindowClosed();
    await lifecycle.waitForCleanup();

    expect(runCleanup).not.toHaveBeenCalled();
    expect(runtime.reportCleanupFailure).toHaveBeenCalledWith(
      schedulingFailure,
    );
    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "watchdog-scheduling-failed" }),
    );
    expect(activityRelease).not.toHaveBeenCalled();
    expect(mutationRelease).not.toHaveBeenCalled();
  });

  it("forces exit if successful cleanup cannot safely release suspension", async () => {
    const releaseFailure = new Error("release failed");
    const runtime = makeRuntime();
    const lifecycle = makeLifecycle({
      suspendMutations: () => ({
        release: () => {
          throw releaseFailure;
        },
      }),
      runtime,
    });

    lifecycle.handleMainWindowClosed();
    await lifecycle.waitForCleanup();

    expect(runtime.reportCleanupFailure).toHaveBeenCalledWith(releaseFailure);
    expect(runtime.reportForcedExit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cleanup-success-handler-failed" }),
    );
    expect(runtime.forceExit).toHaveBeenCalledWith(
      MAIN_WINDOW_CLOSE_FAILURE_EXIT_CODE,
    );
  });

  it("falls back to emergency exit when Electron force exit throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const emergencyExit = vi.fn(() => {
      throw new Error("process exit sentinel");
    });
    const runtime = makeRuntime({
      forceExit: vi.fn(() => {
        throw new Error("app.exit failed");
      }),
      emergencyExit,
    });
    const lifecycle = makeLifecycle({
      runCleanup: async () => {
        throw new Error("cleanup failed");
      },
      runtime,
    });

    lifecycle.handleMainWindowClosed();
    await lifecycle.waitForCleanup();
    expect(emergencyExit).toHaveBeenCalledWith(
      MAIN_WINDOW_CLOSE_FAILURE_EXIT_CODE,
    );
  });

  it("does not reopen gates permanently closed during cleanup", async () => {
    vi.resetModules();
    const { libraryMutationCoordinator } =
      await import("../src/main/libraryStore/libraryMutationCoordinator");
    const activityGate = new AppActivityGate();
    const cleanup = createDeferred<void>();
    const lifecycle = makeLifecycle({
      suspendActivities: () => activityGate.suspendNewActivities(),
      suspendMutations: () => libraryMutationCoordinator.suspendNewMutations(),
      runCleanup: () => cleanup.promise,
    });

    lifecycle.handleMainWindowClosed();
    const waiting = lifecycle.waitForCleanup();
    activityGate.closeToNewActivities();
    libraryMutationCoordinator.closeToNewMutations();
    cleanup.resolve(undefined);
    await waiting;

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
  });
});

function makeLifecycle(
  overrides: Partial<
    ConstructorParameters<typeof MainWindowSessionLifecycle>[0]
  > = {},
): MainWindowSessionLifecycle {
  return new MainWindowSessionLifecycle({
    suspendActivities: () => ({ release: vi.fn() }),
    suspendMutations: () => ({ release: vi.fn() }),
    runCleanup: async () => undefined,
    openWindow: vi.fn(),
    runtime: makeRuntime(),
    ...overrides,
  });
}

function makeRuntime(
  overrides: Partial<MainWindowSessionLifecycleRuntime> = {},
): MainWindowSessionLifecycleRuntime {
  return {
    platform: "darwin",
    now: vi.fn(() => Date.now()),
    schedule: vi.fn((callback, delayMs) => setTimeout(callback, delayMs)),
    clearScheduled: vi.fn((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    ),
    forceExit: vi.fn(),
    emergencyExit: vi.fn((code) => process.exit(code)),
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
