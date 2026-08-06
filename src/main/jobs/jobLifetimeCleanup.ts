export type JobResourceCleanup = () => Promise<void>;

export type JobLifetimeCleanupBoundary = {
  cleanup: () => Promise<void>;
  registerResourceCleanup: (cleanup: JobResourceCleanup) => void;
  finish: () => void;
};

type CleanupOutcome = { ok: true } | { ok: false; error: unknown };

type CleanupRegistration = {
  cleanup: JobResourceCleanup;
  outcome: Promise<CleanupOutcome> | null;
};

export function createJobLifetimeCleanupBoundary(): JobLifetimeCleanupBoundary {
  let resolveFinished: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const registrations: CleanupRegistration[] = [];
  let cleanupRequested = false;
  let finishedState = false;

  const startRegistration = (
    registration: CleanupRegistration,
  ): Promise<CleanupOutcome> => {
    if (registration.outcome) {
      return registration.outcome;
    }

    registration.outcome = Promise.resolve()
      .then(registration.cleanup)
      .then(
        (): CleanupOutcome => ({ ok: true }),
        (error): CleanupOutcome => ({ ok: false, error }),
      );
    return registration.outcome;
  };

  const registerResourceCleanup = (cleanup: JobResourceCleanup): void => {
    if (typeof cleanup !== "function") {
      throw new TypeError("Job resource cleanup must be a function.");
    }
    if (finishedState) {
      throw new Error(
        "Cannot register a resource cleanup after job completion.",
      );
    }

    const registration: CleanupRegistration = { cleanup, outcome: null };
    registrations.push(registration);
    if (cleanupRequested) {
      void startRegistration(registration);
    }
  };

  const cleanup = async (): Promise<void> => {
    if (!finishedState) {
      cleanupRequested = true;
      for (const registration of registrations) {
        void startRegistration(registration);
      }
    }

    await finished;

    const outcomes = await Promise.all(
      registrations.flatMap((registration) =>
        registration.outcome ? [registration.outcome] : [],
      ),
    );
    const errors = outcomes.flatMap((outcome) =>
      outcome.ok ? [] : [outcome.error],
    );

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Multiple job resource cleanups failed.",
      );
    }
  };

  const finish = (): void => {
    if (finishedState) {
      return;
    }
    finishedState = true;
    resolveFinished?.();
  };

  return { cleanup, registerResourceCleanup, finish };
}
