import { performance } from "node:perf_hooks";
import { ipcEventContracts } from "../../shared/ipcContracts";
import {
  isTerminalJobStatus,
  JOB_PROGRESS_TEXT_LIMIT,
  JOB_DETAIL_TEXT_LIMIT,
  JOB_INSTALL_LOG_LINES_LIMIT,
} from "../../shared/jobContracts";
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
    Map<string, JobEventDispatchQueue>
  >();
  const resolveQueue = (
    jobs: ActiveJobStore,
    id: string,
  ): JobEventDispatchQueue => {
    let queues = dispatchQueueByJobs.get(jobs);
    if (!queues) {
      queues = new Map();
      dispatchQueueByJobs.set(jobs, queues);
    }
    const existing = queues.get(id);
    if (existing) {
      return existing;
    }
    const queue = createJobEventDispatchQueue((mainWindow, event) =>
      dispatchJobEvent(mainWindow, event, runtime),
    );
    queues.set(id, queue);
    return queue;
  };
  return (jobs, mainWindow, untagged) => {
    const current = jobs.get(untagged.id);
    if (
      current?.id !== untagged.id ||
      (current.lastEvent && isTerminalJobStatus(current.lastEvent.status))
    ) {
      return;
    }
    const tagged = current.origin
      ? { ...untagged, origin: current.origin }
      : untagged;
    const event = boundJobEventText(tagged, runtime);
    jobs.updateLastEvent(event.id, event);
    const queue = resolveQueue(jobs, event.id);
    queue.enqueue(mainWindow, event);
    if (isTerminalJobStatus(event.status)) {
      queue.dispose();
      dispatchQueueByJobs.get(jobs)?.delete(event.id);
    }
  };
}

export const emitJobEvent = createJobEventEmitter();

function boundJobEventText(
  event: JobEvent,
  runtime: JobEventEmitterRuntime,
): JobEvent {
  let shortened = false;
  const bound = (text: string, limit: number): string => {
    if (text.length <= limit) return text;
    shortened = true;
    return `${text.slice(0, limit - 1)}…`;
  };
  const result: JobEvent = {
    ...event,
    progressText: bound(event.progressText, JOB_PROGRESS_TEXT_LIMIT),
    ...(event.detail === undefined
      ? {}
      : { detail: bound(event.detail, JOB_DETAIL_TEXT_LIMIT) }),
    ...(event.installLogLine === undefined
      ? {}
      : { installLogLine: bound(event.installLogLine, JOB_DETAIL_TEXT_LIMIT) }),
    ...(event.notification
      ? {
          notification: {
            ...event.notification,
            message: bound(event.notification.message, JOB_PROGRESS_TEXT_LIMIT),
          },
        }
      : {}),
    ...(event.installLogLines
      ? {
          installLogLines: event.installLogLines
            .slice(-JOB_INSTALL_LOG_LINES_LIMIT)
            .map((line) => bound(line, JOB_DETAIL_TEXT_LIMIT)),
        }
      : {}),
  };
  if (
    shortened ||
    (event.installLogLines?.length ?? 0) > JOB_INSTALL_LOG_LINES_LIMIT
  ) {
    runtime.writeLog(
      event.status === "failed" ? "error" : "info",
      "Job event text shortened for IPC; full diagnostic",
      {
        id: event.id,
        executionId: event.executionId,
        progressText: event.progressText,
        detail: event.detail,
        installLogLine: event.installLogLine,
        installLogLines: event.installLogLines,
        notification: event.notification,
      },
    );
  }
  return result;
}

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
      executionId: event.executionId,
      progressText: event.progressText,
      phase: event.phase,
      progressCurrent: event.progressCurrent,
      progressTotal: event.progressTotal,
      workflowProgress: event.workflowProgress,
      progressMode: event.progressMode,
      progressPercent: event.progressPercent,
      progressBytes: event.progressBytes,
      progressTotalBytes: event.progressTotalBytes,
      progressBytesPerSecond: event.progressBytesPerSecond,
      installLogLine: event.installLogLine,
      notification: event.notification,
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
