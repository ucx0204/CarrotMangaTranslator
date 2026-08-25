import { performance } from "node:perf_hooks";
import { ipcEventContracts } from "../../shared/ipcContracts";
import { isTerminalJobStatus } from "../../shared/jobContracts";
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

type PageTiming = {
  firstSeenAt: number;
  runningAt?: number;
};

const PAGE_ACTIVITY_PHASES = new Set([
  "ocr_preparing",
  "ocr_running",
  "model_requesting",
  "page_running",
  "page_retry",
]);

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
    const current = jobs.current;
    if (
      current?.id !== event.id ||
      (current.lastEvent && isTerminalJobStatus(current.lastEvent.status))
    ) {
      return;
    }
    jobs.updateLastEvent(event.id, event);
    const queue = resolveQueue(jobs);
    queue.enqueue(mainWindow, event);
    if (isTerminalJobStatus(event.status)) {
      queue.dispose();
      dispatchQueueByJobs.delete(jobs);
    }
  };
}

export const emitJobEvent = createJobEventEmitter();

export function createAnalysisJobEventTimer(
  now: () => number = () => performance.now(),
): (event: JobEvent) => JobEvent {
  const jobStartedAt = now();
  const pageTimings = new Map<number, PageTiming>();

  return (event) => {
    const eventAt = now();
    const pageIndex = normalizePageIndex(event.pageIndex);
    recordPageActivity(event, pageIndex, eventAt, pageTimings);

    const pageElapsedMs = resolvePageElapsedMs(
      event,
      pageIndex,
      eventAt,
      pageTimings,
    );
    const jobElapsedMs =
      event.status === "completed" && event.phase === "done"
        ? elapsedSince(jobStartedAt, eventAt)
        : undefined;

    if (pageElapsedMs === undefined && jobElapsedMs === undefined) {
      return event;
    }
    return {
      ...event,
      ...(pageElapsedMs === undefined ? {} : { pageElapsedMs }),
      ...(jobElapsedMs === undefined ? {} : { jobElapsedMs }),
    };
  };
}

function recordPageActivity(
  event: JobEvent,
  pageIndex: number | undefined,
  eventAt: number,
  pageTimings: Map<number, PageTiming>,
): void {
  if (
    pageIndex === undefined ||
    !event.phase ||
    !PAGE_ACTIVITY_PHASES.has(event.phase)
  ) {
    return;
  }
  const timing = pageTimings.get(pageIndex) ?? { firstSeenAt: eventAt };
  if (event.phase === "page_running" && timing.runningAt === undefined) {
    timing.runningAt = eventAt;
  }
  pageTimings.set(pageIndex, timing);
}

function resolvePageElapsedMs(
  event: JobEvent,
  pageIndex: number | undefined,
  eventAt: number,
  pageTimings: Map<number, PageTiming>,
): number | undefined {
  if (event.phase !== "page_done" || pageIndex === undefined) {
    return undefined;
  }
  const timing = pageTimings.get(pageIndex);
  pageTimings.delete(pageIndex);
  if (!timing) {
    return undefined;
  }
  return elapsedSince(timing.runningAt ?? timing.firstSeenAt, eventAt);
}

function normalizePageIndex(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function elapsedSince(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

function dispatchJobEvent(
  mainWindow: JobEventWindow | null,
  event: JobEvent,
  runtime: JobEventEmitterRuntime,
): void {
  runtime.writeLog(
    event.status === "failed"
      ? "error"
      : event.status === "cancelled" || event.status === "partial"
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
      pageElapsedMs: event.pageElapsedMs,
      jobElapsedMs: event.jobElapsedMs,
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

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
