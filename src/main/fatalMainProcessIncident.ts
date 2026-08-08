import { APP_QUIT_HARD_DEADLINE_MS } from "./appQuitCoordinator";

export const FATAL_MAIN_PROCESS_CLEANUP_HARD_DEADLINE_MS =
  APP_QUIT_HARD_DEADLINE_MS;
export const FATAL_MAIN_PROCESS_EXIT_CODE = 1;

export type FatalMainProcessIncidentSource =
  | "uncaught-exception"
  | "unhandled-rejection";

type FatalForcedExitReason =
  | "cleanup-complete"
  | "cleanup-failed"
  | "hard-deadline"
  | "watchdog-scheduling-failed"
  | "secondary-fatal-incident";

export type FatalMainProcessIncidentRuntime = {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  clearScheduled: (handle: unknown) => void;
  setExitCode: (code: number) => void;
  forceExit: (code: number) => void;
  emergencyExit: (code: number) => never;
  reportCleanupFailure: (error: unknown) => void;
  reportForcedExit: (detail: {
    reason: FatalForcedExitReason;
    source: FatalMainProcessIncidentSource;
    elapsedMs: number;
    deadlineMs: number;
  }) => void;
  reportSecondaryIncident: (
    source: FatalMainProcessIncidentSource,
    reason: unknown,
  ) => void;
};

type FatalIncidentOptions = {
  source: FatalMainProcessIncidentSource;
  reason: unknown;
  closeIntake: () => void;
  notifyIncident: () => void;
  isolateNormalWindows: () => void;
  runCleanup: () => Promise<void>;
  runtime: FatalMainProcessIncidentRuntime;
};

type FatalAttempt = {
  source: FatalMainProcessIncidentSource;
  startedAt: number;
  runtime: FatalMainProcessIncidentRuntime;
  completion: Promise<void>;
  resolveCompletion: () => void;
  watchdog: unknown;
  forceExitTriggered: boolean;
};

export class FatalMainProcessIncidentCoordinator {
  private currentAttempt: FatalAttempt | null = null;

  get isHandling(): boolean {
    return this.currentAttempt !== null;
  }

  begin(options: FatalIncidentOptions): { completion: Promise<void> } {
    if (this.currentAttempt) {
      reportSafely(
        () =>
          options.runtime.reportSecondaryIncident(
            options.source,
            options.reason,
          ),
        "Failed to report secondary fatal main-process incident",
      );
      this.forceExit(this.currentAttempt, "secondary-fatal-incident");
      this.currentAttempt.resolveCompletion();
      return { completion: this.currentAttempt.completion };
    }

    const attempt = this.createAttempt(options);
    this.currentAttempt = attempt;
    invokeSafely(
      () => options.runtime.setExitCode(FATAL_MAIN_PROCESS_EXIT_CODE),
      "Failed to set fatal main-process exit code",
    );
    invokeSafely(options.closeIntake, "Failed to close fatal incident intake");
    invokeSafely(options.notifyIncident, "Failed to report fatal incident");
    invokeSafely(
      options.isolateNormalWindows,
      "Failed to isolate normal windows during fatal shutdown",
    );

    if (!this.armWatchdog(attempt)) {
      return { completion: attempt.completion };
    }
    void Promise.resolve()
      .then(options.runCleanup)
      .then(
        () => this.finishCleanup(attempt),
        (error) => this.finishCleanup(attempt, error),
      );
    return { completion: attempt.completion };
  }

  private createAttempt(options: FatalIncidentOptions): FatalAttempt {
    const deferred = createDeferred();
    return {
      source: options.source,
      startedAt: options.runtime.now(),
      runtime: options.runtime,
      completion: deferred.promise,
      resolveCompletion: deferred.resolve,
      watchdog: null,
      forceExitTriggered: false,
    };
  }

  private armWatchdog(attempt: FatalAttempt): boolean {
    try {
      attempt.watchdog = attempt.runtime.schedule(() => {
        this.forceExit(attempt, "hard-deadline");
        attempt.resolveCompletion();
      }, FATAL_MAIN_PROCESS_CLEANUP_HARD_DEADLINE_MS);
      return true;
    } catch (error) {
      this.reportCleanupFailure(attempt, error);
      this.forceExit(attempt, "watchdog-scheduling-failed");
      attempt.resolveCompletion();
      return false;
    }
  }

  private finishCleanup(attempt: FatalAttempt, error?: unknown): void {
    if (attempt.forceExitTriggered) {
      attempt.resolveCompletion();
      return;
    }
    let exitReason: FatalForcedExitReason = "cleanup-complete";
    if (error !== undefined) {
      this.reportCleanupFailure(attempt, error);
      exitReason = "cleanup-failed";
    }
    try {
      attempt.runtime.clearScheduled(attempt.watchdog);
    } catch (clearError) {
      this.reportCleanupFailure(attempt, clearError);
      exitReason = "cleanup-failed";
    }
    this.forceExit(attempt, exitReason);
    attempt.resolveCompletion();
  }

  private reportCleanupFailure(attempt: FatalAttempt, error: unknown): void {
    reportSafely(
      () => attempt.runtime.reportCleanupFailure(error),
      "Failed to report fatal main-process cleanup failure",
    );
  }

  private forceExit(
    attempt: FatalAttempt,
    reason: FatalForcedExitReason,
  ): void {
    if (attempt.forceExitTriggered) {
      return;
    }
    attempt.forceExitTriggered = true;
    reportSafely(
      () =>
        attempt.runtime.reportForcedExit({
          reason,
          source: attempt.source,
          elapsedMs: Math.max(0, attempt.runtime.now() - attempt.startedAt),
          deadlineMs: FATAL_MAIN_PROCESS_CLEANUP_HARD_DEADLINE_MS,
        }),
      "Failed to report forced fatal main-process exit",
    );
    forceExitWithFallback(attempt.runtime);
  }
}

function forceExitWithFallback(runtime: FatalMainProcessIncidentRuntime): void {
  try {
    runtime.forceExit(FATAL_MAIN_PROCESS_EXIT_CODE);
  } catch (error) {
    console.error("Electron app.exit failed during fatal shutdown", error);
    try {
      runtime.emergencyExit(FATAL_MAIN_PROCESS_EXIT_CODE);
    } catch (emergencyError) {
      console.error("Emergency process exit failed", emergencyError);
    }
  }
}

function invokeSafely(callback: () => void, message: string): void {
  try {
    callback();
  } catch (error) {
    console.error(message, error);
  }
}

function reportSafely(report: () => void, message: string): void {
  invokeSafely(report, message);
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
    throw new Error("Failed to initialize fatal incident completion.");
  }
  return { promise, resolve: resolvePromise };
}
