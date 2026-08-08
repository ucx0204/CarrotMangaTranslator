import { APP_QUIT_HARD_DEADLINE_MS } from "./appQuitCoordinator";

export const MAIN_WINDOW_CLOSE_CLEANUP_HARD_DEADLINE_MS =
  APP_QUIT_HARD_DEADLINE_MS;
export const MAIN_WINDOW_CLOSE_FAILURE_EXIT_CODE = 1;

type ReleasableLease = {
  release: () => void;
};

type MainWindowCloseForcedExitReason =
  | "hard-deadline"
  | "cleanup-failed"
  | "watchdog-scheduling-failed"
  | "cleanup-success-handler-failed";

export type MainWindowSessionLifecycleRuntime = {
  platform: NodeJS.Platform;
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  clearScheduled: (handle: unknown) => void;
  forceExit: (code: number) => void;
  emergencyExit: (code: number) => never;
  reportCleanupFailure: (error: unknown) => void;
  reportForcedExit: (detail: {
    reason: MainWindowCloseForcedExitReason;
    elapsedMs: number;
    deadlineMs: number;
  }) => void;
};

type CleanupAttempt = {
  startedAt: number;
  activitySuspension: ReleasableLease | null;
  mutationSuspension: ReleasableLease | null;
  watchdog: unknown;
  forceExitTriggered: boolean;
  completion: Promise<void>;
  resolveCompletion: () => void;
};

export class MainWindowSessionLifecycle {
  private terminal = false;
  private reopenPending = false;
  private cleanupCompletion: Promise<void> | null = null;

  constructor(
    private readonly options: {
      suspendActivities: () => ReleasableLease;
      suspendMutations: () => ReleasableLease;
      runCleanup: () => Promise<void>;
      openWindow: () => void;
      runtime: MainWindowSessionLifecycleRuntime;
    },
  ) {}

  get isCleanupInFlight(): boolean {
    return this.cleanupCompletion !== null;
  }

  handleMainWindowClosed(): void {
    if (
      this.options.runtime.platform !== "darwin" ||
      this.terminal ||
      this.cleanupCompletion
    ) {
      return;
    }
    this.beginCleanup();
  }

  requestWindowOpen(): void {
    if (this.terminal) {
      return;
    }
    if (this.cleanupCompletion) {
      this.reopenPending = true;
      return;
    }
    this.options.openWindow();
  }

  enterTerminalMode(): void {
    this.terminal = true;
    this.reopenPending = false;
  }

  waitForCleanup(): Promise<void> {
    return this.cleanupCompletion ?? Promise.resolve();
  }

  private beginCleanup(): void {
    const deferred = createDeferred();
    const attempt: CleanupAttempt = {
      startedAt: this.options.runtime.now(),
      activitySuspension: null,
      mutationSuspension: null,
      watchdog: null,
      forceExitTriggered: false,
      completion: deferred.promise,
      resolveCompletion: deferred.resolve,
    };
    this.cleanupCompletion = attempt.completion;

    try {
      attempt.activitySuspension = this.options.suspendActivities();
      attempt.mutationSuspension = this.options.suspendMutations();
    } catch (error) {
      this.failCleanup(attempt, "cleanup-failed", error);
      return;
    }

    try {
      attempt.watchdog = this.options.runtime.schedule(
        () => this.failCleanup(attempt, "hard-deadline"),
        MAIN_WINDOW_CLOSE_CLEANUP_HARD_DEADLINE_MS,
      );
    } catch (error) {
      this.failCleanup(attempt, "watchdog-scheduling-failed", error);
      return;
    }

    void Promise.resolve()
      .then(this.options.runCleanup)
      .then(
        () => this.finishCleanup(attempt),
        (error) => this.failCleanup(attempt, "cleanup-failed", error),
      );
  }

  private finishCleanup(attempt: CleanupAttempt): void {
    if (attempt.forceExitTriggered) {
      attempt.resolveCompletion();
      return;
    }
    try {
      this.options.runtime.clearScheduled(attempt.watchdog);
      attempt.mutationSuspension?.release();
      attempt.activitySuspension?.release();
      this.cleanupCompletion = null;

      const shouldReopen = this.reopenPending && !this.terminal;
      this.reopenPending = false;
      if (shouldReopen) {
        this.options.openWindow();
      }
      attempt.resolveCompletion();
    } catch (error) {
      this.failCleanup(attempt, "cleanup-success-handler-failed", error);
    }
  }

  private failCleanup(
    attempt: CleanupAttempt,
    reason: MainWindowCloseForcedExitReason,
    error?: unknown,
  ): void {
    this.enterTerminalMode();
    this.cleanupCompletion = null;
    if (error !== undefined) {
      reportSafely(
        () => this.options.runtime.reportCleanupFailure(error),
        "Failed to report main-window close cleanup failure",
      );
    }
    this.forceExit(attempt, reason);
    attempt.resolveCompletion();
  }

  private forceExit(
    attempt: CleanupAttempt,
    reason: MainWindowCloseForcedExitReason,
  ): void {
    if (attempt.forceExitTriggered) {
      return;
    }
    attempt.forceExitTriggered = true;
    reportSafely(
      () =>
        this.options.runtime.reportForcedExit({
          reason,
          elapsedMs: Math.max(
            0,
            this.options.runtime.now() - attempt.startedAt,
          ),
          deadlineMs: MAIN_WINDOW_CLOSE_CLEANUP_HARD_DEADLINE_MS,
        }),
      "Failed to report forced exit after main-window close",
    );
    forceExitWithFallback(this.options.runtime);
  }
}

function forceExitWithFallback(
  runtime: MainWindowSessionLifecycleRuntime,
): void {
  try {
    runtime.forceExit(MAIN_WINDOW_CLOSE_FAILURE_EXIT_CODE);
  } catch (error) {
    console.error("Electron app.exit failed after main-window close", error);
    try {
      runtime.emergencyExit(MAIN_WINDOW_CLOSE_FAILURE_EXIT_CODE);
    } catch (emergencyError) {
      console.error("Emergency process exit failed", emergencyError);
    }
  }
}

function reportSafely(report: () => void, message: string): void {
  try {
    report();
  } catch (error) {
    console.error(message, error);
  }
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Failed to initialize lifecycle completion.");
  }
  return { promise, resolve: resolvePromise };
}
