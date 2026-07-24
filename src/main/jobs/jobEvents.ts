import { ipcEventContracts } from "../../shared/ipcContracts";
import type { JobEvent } from "../../shared/jobTypes";
import { writeLog } from "../logger";
import type { ActiveJobStore } from "./activeJob";
import {
  createJobEventDispatchQueue,
  type JobEventDispatchQueue,
  type JobEventWindow,
} from "./jobEventDispatchQueue";

type JobEventEmitterRuntime = {
  validateEvent: (event: JobEvent) => void;
  writeLog: typeof writeLog;
};

const productionRuntime: JobEventEmitterRuntime = {
  validateEvent: (event) => {
    ipcEventContracts.jobEvent.payload.parse(event);
  },
  writeLog,
};

export function createJobEventEmitter(
  runtime: JobEventEmitterRuntime = productionRuntime,
): (
  jobs: ActiveJobStore,
  mainWindow: JobEventWindow | null,
  event: JobEvent,
) => void {
  const dispatchQueueByJobs = new WeakMap<
    ActiveJobStore,
    JobEventDispatchQueue
  >();
  const resolveQueue = (jobs: ActiveJobStore): JobEventDispatchQueue => {
    const existing = dispatchQueueByJobs.get(jobs);
    if (existing) {
      return existing;
    }
    const queue = createJobEventDispatchQueue((mainWindow, event) =>
      dispatchJobEvent(mainWindow, event, runtime),
    );
    dispatchQueueByJobs.set(jobs, queue);
    return queue;
  };
  return (jobs, mainWindow, event) => {
    if (jobs.current?.id !== event.id) {
      return;
    }
    jobs.updateLastEvent(event.id, event);
    const queue = resolveQueue(jobs);
    queue.enqueue(mainWindow, event);
    if (isTerminalJobEvent(event)) {
      queue.dispose();
      dispatchQueueByJobs.delete(jobs);
    }
  };
}

export const emitJobEvent = createJobEventEmitter();

function dispatchJobEvent(
  mainWindow: JobEventWindow | null,
  event: JobEvent,
  runtime: JobEventEmitterRuntime,
): void {
  runtime.writeLog(
    event.status === "failed"
      ? "error"
      : event.status === "cancelled"
        ? "warn"
        : "info",
    `job:${event.kind}:${event.status}`,
    {
      id: event.id,
      progressText: event.progressText,
      phase: event.phase,
      progressCurrent: event.progressCurrent,
      progressTotal: event.progressTotal,
      progressMode: event.progressMode,
      progressPercent: event.progressPercent,
      progressBytes: event.progressBytes,
      progressTotalBytes: event.progressTotalBytes,
      progressBytesPerSecond: event.progressBytesPerSecond,
      installLogLine: event.installLogLine,
      pageIndex: event.pageIndex,
      pageTotal: event.pageTotal,
      attempt: event.attempt,
      attemptTotal: event.attemptTotal,
      detail: event.detail,
    },
  );
  if (!canSendJobEvent(mainWindow)) {
    return;
  }
  runtime.validateEvent(event);
  try {
    mainWindow.webContents.send(ipcEventContracts.jobEvent.channel, event);
  } catch (error) {
    runtime.writeLog("warn", "Failed to deliver job event to renderer", {
      jobId: event.id,
      status: event.status,
      error,
    });
  }
}

function canSendJobEvent(
  mainWindow: JobEventWindow | null,
): mainWindow is JobEventWindow {
  return Boolean(
    mainWindow &&
    !mainWindow.isDestroyed?.() &&
    !mainWindow.webContents.isDestroyed?.(),
  );
}

function isTerminalJobEvent(event: JobEvent): boolean {
  return (
    event.status === "cancelled" ||
    event.status === "failed" ||
    event.status === "completed"
  );
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
