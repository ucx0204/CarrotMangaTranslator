import type { JobEvent } from "../../shared/jobTypes";

export const JOB_EVENT_DISPATCH_INTERVAL_MS = 32;

export type JobEventWindow = {
  isDestroyed?: () => boolean;
  webContents: {
    isDestroyed?: () => boolean;
    send: (channel: string, event: JobEvent) => void;
  };
};

type PendingJobEvent = {
  mainWindow: JobEventWindow | null;
  event: JobEvent;
};

export type JobEventDispatchQueueRuntime = {
  cancel: (handle: unknown) => void;
  dispatch: (mainWindow: JobEventWindow | null, event: JobEvent) => void;
  schedule: (callback: () => void, delayMs: number) => unknown;
};

export type JobEventDispatchQueue = {
  dispose: () => void;
  enqueue: (mainWindow: JobEventWindow | null, event: JobEvent) => void;
  flush: () => void;
};

const productionScheduler = {
  cancel: (handle: unknown) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback: () => void, delayMs: number) =>
    setTimeout(callback, delayMs),
};

export function createJobEventDispatchQueue(
  dispatch: JobEventDispatchQueueRuntime["dispatch"],
  runtime: Pick<
    JobEventDispatchQueueRuntime,
    "cancel" | "schedule"
  > = productionScheduler,
): JobEventDispatchQueue {
  let pending: PendingJobEvent | null = null;
  let scheduledHandle: unknown;
  let disposed = false;

  const flush = (): void => {
    if (scheduledHandle !== undefined) {
      runtime.cancel(scheduledHandle);
      scheduledHandle = undefined;
    }
    const next = pending;
    pending = null;
    if (next) {
      dispatch(next.mainWindow, next.event);
    }
  };

  return {
    dispose: () => {
      if (scheduledHandle !== undefined) {
        runtime.cancel(scheduledHandle);
      }
      scheduledHandle = undefined;
      pending = null;
      disposed = true;
    },
    enqueue: (mainWindow, event) => {
      if (disposed) {
        throw new Error("Disposed job event queue cannot accept events.");
      }
      if (!shouldCoalesceJobEvent(event)) {
        flush();
        dispatch(mainWindow, event);
        return;
      }
      pending = { mainWindow, event };
      if (scheduledHandle === undefined) {
        scheduledHandle = runtime.schedule(
          flush,
          JOB_EVENT_DISPATCH_INTERVAL_MS,
        );
      }
    },
    flush,
  };
}

export function shouldCoalesceJobEvent(event: JobEvent): boolean {
  if (event.status !== "starting" && event.status !== "running") {
    return false;
  }
  if (isLiveChapterCheckpoint(event)) {
    return false;
  }
  return (
    event.progressMode !== undefined ||
    event.progressPercent !== undefined ||
    event.progressBytes !== undefined ||
    event.progressBytesPerSecond !== undefined ||
    event.installLogLine !== undefined
  );
}

function isLiveChapterCheckpoint(event: JobEvent): boolean {
  return (
    event.phase === "page_done" ||
    event.phase === "page_skipped" ||
    event.phase === "inpainting_done"
  );
}
