export const STARTUP_MAINTENANCE_DELAY_MS = 30_000;

type StartupMaintenanceRuntime = {
  cancel: (handle: unknown) => void;
  schedule: (callback: () => void, delayMs: number) => unknown;
};

export type StartupMaintenanceOptions = {
  isBusy: () => boolean;
  reportError: (error: unknown) => void;
  run: () => Promise<void>;
  delayMs?: number;
  runtime?: StartupMaintenanceRuntime;
};

const productionRuntime: StartupMaintenanceRuntime = {
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
};

export function scheduleStartupMaintenance({
  isBusy,
  reportError,
  run,
  delayMs = STARTUP_MAINTENANCE_DELAY_MS,
  runtime = productionRuntime,
}: StartupMaintenanceOptions): () => void {
  let cancelled = false;
  let scheduledHandle: unknown;

  const schedule = (): void => {
    scheduledHandle = runtime.schedule(runWhenIdle, delayMs);
  };
  const runWhenIdle = (): void => {
    scheduledHandle = undefined;
    if (cancelled) {
      return;
    }
    if (isBusy()) {
      schedule();
      return;
    }
    void run().catch(reportError);
  };

  schedule();
  return () => {
    cancelled = true;
    if (scheduledHandle !== undefined) {
      runtime.cancel(scheduledHandle);
      scheduledHandle = undefined;
    }
  };
}
