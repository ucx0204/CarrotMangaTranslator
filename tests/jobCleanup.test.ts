import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ipcEventContracts,
  jobControlIpcContracts,
} from "../src/shared/ipcContracts";
import type { ActiveJob } from "../src/main/jobs/activeJob";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import { createJobLifetimeCleanupBoundary } from "../src/main/jobs/jobLifetimeCleanup";
import {
  BEFORE_QUIT_CLEANUP_TIMEOUT_MS,
  type ActiveJobCleanupReason,
  canReleaseInpaintingHistoryAfterQuitCleanup,
  finishActiveJobCleanup,
  finishBeforeQuitCleanup,
} from "../src/main/jobs/beforeQuitCleanup";
import { registerJobControlIpc } from "../src/main/ipc/jobControlIpc";

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown> | unknown;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    }),
  };
});

const loggerMock = {
  logError: vi.fn(),
  logInfo: vi.fn(),
};

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { handle: electronMock.handle },
}));

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  loggerMock.logError.mockClear();
  loggerMock.logInfo.mockClear();
});

describe("ActiveJobStore cleanup", () => {
  it("runs an installed cleanup exactly once across concurrent and later calls", async () => {
    const cleanupGate = createDeferred<void>();
    const cleanup = vi.fn(() => cleanupGate.promise);
    const job = makeActiveJob(cleanup);
    const jobs = new ActiveJobStore({
      error: loggerMock.logError,
      info: loggerMock.logInfo,
    });
    jobs.start(job);

    const first = jobs.runCleanup(job, "first");
    const concurrent = jobs.runCleanup(job, "concurrent");

    expect(cleanup).toHaveBeenCalledTimes(1);
    let concurrentSettled = false;
    void concurrent.then(() => {
      concurrentSettled = true;
    });
    await Promise.resolve();
    expect(concurrentSettled).toBe(false);
    cleanupGate.resolve(undefined);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(jobs.runCleanup(job, "later")).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(loggerMock.logInfo).toHaveBeenCalledTimes(1);
  });

  it("shares a job-lifetime cleanup across concurrent cancel and quit callers", async () => {
    const resourceGate = createDeferred<void>();
    const lifetime = createJobLifetimeCleanupBoundary();
    const resourceCleanup = vi.fn(() => resourceGate.promise);
    lifetime.registerResourceCleanup(resourceCleanup);
    const job = makeActiveJob(lifetime.cleanup);
    const jobs = new ActiveJobStore({
      error: loggerMock.logError,
      info: loggerMock.logInfo,
    });
    jobs.start(job);

    const cancelCleanup = jobs.runCleanup(job, "cancel");
    const quitCleanup = jobs.runCleanup(job, "before-quit");
    await Promise.resolve();
    expect(resourceCleanup).toHaveBeenCalledTimes(1);

    lifetime.finish();
    resourceGate.resolve(undefined);
    await expect(Promise.all([cancelCleanup, quitCleanup])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    expect(resourceCleanup).toHaveBeenCalledTimes(1);
    expect(loggerMock.logInfo).toHaveBeenCalledTimes(1);
  });

  it("logs cleanup failures, resolves the boundary call, and does not retry", async () => {
    const failure = new Error("endpoint stop failed");
    const cleanup = vi.fn(async () => {
      throw failure;
    });
    const job = makeActiveJob(cleanup);
    const jobs = new ActiveJobStore({
      error: loggerMock.logError,
      info: loggerMock.logInfo,
    });
    jobs.start(job);

    await expect(jobs.runCleanup(job, "cancel")).resolves.toBeUndefined();
    await expect(jobs.runCleanup(job, "later")).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(loggerMock.logError).toHaveBeenCalledWith(
      "Analysis runtime cleanup failed",
      expect.objectContaining({
        error: failure,
        jobId: job.id,
        reason: "cancel",
      }),
    );
  });
});

describe("job cancellation IPC", () => {
  it("emits cancelling state, aborts the job, then awaits cleanup", async () => {
    const events: string[] = [];
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const cleanupGate = createDeferred<void>();
    const jobs = new ActiveJobStore();
    const job = makeActiveJob();
    job.cleanup = async () => {
      events.push(`cleanup:start:${job.abortController.signal.aborted}`);
      await cleanupGate.promise;
      events.push("cleanup:end");
    };
    job.abortController.signal.addEventListener("abort", () => {
      events.push("abort");
    });
    jobs.start(job);

    const rendererUrl = "http://127.0.0.1:5173/";
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        getURL: () => rendererUrl,
        id: 17,
        send: (channel: string, payload: unknown) => {
          events.push("event");
          sent.push({ channel, payload });
        },
      },
    } as BrowserWindow;
    registerJobControlIpc({ jobs, getMainWindow: () => mainWindow });

    const handler = electronMock.handlers.get(
      jobControlIpcContracts.cancelJob.channel,
    );
    if (!handler) {
      throw new Error("Cancel job IPC handler was not registered.");
    }
    const invocation = Promise.resolve(
      handler({
        sender: { id: 17 },
        senderFrame: { url: rendererUrl },
      } as IpcMainInvokeEvent),
    );
    await Promise.resolve();

    expect(events).toEqual(["event", "abort", "cleanup:start:true"]);
    cleanupGate.resolve(undefined);
    const result = await invocation;

    expect(result).toEqual({ cancelled: true });
    expect(job.lastEvent).toEqual(
      expect.objectContaining({
        id: job.id,
        status: "cancelling",
      }),
    );
    expect(events).toEqual([
      "event",
      "abort",
      "cleanup:start:true",
      "cleanup:end",
    ]);
    expect(sent).toEqual([
      {
        channel: ipcEventContracts.jobEvent.channel,
        payload: expect.objectContaining({
          id: job.id,
          kind: job.kind,
          status: "cancelling",
        }),
      },
    ]);
  });
});

describe("before-quit cleanup", () => {
  it("does not release revision history after an inpainting cleanup timeout", () => {
    expect(
      canReleaseInpaintingHistoryAfterQuitCleanup("inpainting", {
        timedOut: true,
      }),
    ).toBe(false);
    expect(
      canReleaseInpaintingHistoryAfterQuitCleanup("inpainting", {
        timedOut: false,
      }),
    ).toBe(true);
    expect(
      canReleaseInpaintingHistoryAfterQuitCleanup("gemma-analysis", {
        timedOut: true,
      }),
    ).toBe(true);
  });

  it("aborts, completes cleanup, cancels the timeout, then clears the job", async () => {
    const events: string[] = [];
    const job = makeActiveJob();
    job.abortController.signal.addEventListener("abort", () => {
      events.push("abort");
    });
    const timer = {} as ReturnType<typeof setTimeout>;
    const jobs = {
      clearIfCurrent: vi.fn((jobId: string) => {
        events.push(`clear:${jobId}`);
      }),
      runCleanup: vi.fn(async (_job: ActiveJob, reason: string) => {
        events.push(`cleanup:${reason}`);
      }),
    };
    const warnTimedOut = vi.fn();
    const scheduleTimeout = vi.fn(
      (_callback: () => void, timeoutMs: number) => {
        events.push(`schedule:${timeoutMs}`);
        return timer;
      },
    );
    const clearScheduledTimeout = vi.fn(
      (scheduledTimer: ReturnType<typeof setTimeout>) => {
        expect(scheduledTimer).toBe(timer);
        events.push("clear-timeout");
      },
    );

    const result = await finishBeforeQuitCleanup({
      job,
      jobs,
      warnTimedOut,
      reportLateFailure: vi.fn(),
      scheduleTimeout,
      clearScheduledTimeout,
    });

    expect(events).toEqual([
      "abort",
      "cleanup:before-quit",
      `schedule:${BEFORE_QUIT_CLEANUP_TIMEOUT_MS}`,
      "clear-timeout",
      `clear:${job.id}`,
    ]);
    expect(scheduleTimeout).toHaveBeenCalledTimes(1);
    expect(clearScheduledTimeout).toHaveBeenCalledTimes(1);
    expect(warnTimedOut).not.toHaveBeenCalled();
    expect(result).toEqual({
      timedOut: false,
      settlement: expect.any(Promise),
    });
    await result.settlement;
  });

  it("passes an explicit lifecycle reason through generic active-job cleanup", async () => {
    const job = makeActiveJob();
    const reason: ActiveJobCleanupReason = "main-window-closed";
    const jobs = {
      clearIfCurrent: vi.fn(),
      runCleanup: vi.fn(async () => undefined),
    };

    await finishActiveJobCleanup({
      job,
      jobs,
      reason,
      warnTimedOut: vi.fn(),
      reportLateFailure: vi.fn(),
    });

    expect(job.abortController.signal.aborted).toBe(true);
    expect(jobs.runCleanup).toHaveBeenCalledWith(job, "main-window-closed");
    expect(jobs.clearIfCurrent).toHaveBeenCalledWith(job.id);
  });

  it("keeps the active job until timed-out cleanup actually settles", async () => {
    const events: string[] = [];
    const job = makeActiveJob();
    job.abortController.signal.addEventListener("abort", () => {
      events.push("abort");
    });
    const cleanupGate = createDeferred<void>();
    const cleanupFinished = createDeferred<void>();
    const timer = {} as ReturnType<typeof setTimeout>;
    const jobs = {
      clearIfCurrent: vi.fn((jobId: string) => {
        events.push(`clear:${jobId}`);
      }),
      runCleanup: vi.fn(async () => {
        events.push("cleanup:start");
        await cleanupGate.promise;
        events.push("cleanup:end");
        cleanupFinished.resolve(undefined);
      }),
    };
    const warnTimedOut = vi.fn((jobId: string, timeoutMs: number) => {
      events.push(`timeout:${jobId}:${timeoutMs}`);
    });
    const scheduleTimeout = vi.fn((callback: () => void, timeoutMs: number) => {
      events.push(`schedule:${timeoutMs}`);
      callback();
      return timer;
    });
    const clearScheduledTimeout = vi.fn();

    const result = await finishBeforeQuitCleanup({
      job,
      jobs,
      warnTimedOut,
      reportLateFailure: vi.fn(),
      scheduleTimeout,
      clearScheduledTimeout,
    });

    expect(events).toEqual([
      "abort",
      "cleanup:start",
      `schedule:${BEFORE_QUIT_CLEANUP_TIMEOUT_MS}`,
      `timeout:${job.id}:${BEFORE_QUIT_CLEANUP_TIMEOUT_MS}`,
    ]);
    expect(jobs.clearIfCurrent).not.toHaveBeenCalled();
    expect(clearScheduledTimeout).not.toHaveBeenCalled();
    expect(result).toEqual({
      timedOut: true,
      settlement: expect.any(Promise),
    });

    cleanupGate.resolve(undefined);
    await cleanupFinished.promise;
    await result.settlement;

    expect(events).toEqual([
      "abort",
      "cleanup:start",
      `schedule:${BEFORE_QUIT_CLEANUP_TIMEOUT_MS}`,
      `timeout:${job.id}:${BEFORE_QUIT_CLEANUP_TIMEOUT_MS}`,
      "cleanup:end",
      `clear:${job.id}`,
    ]);
    expect(jobs.clearIfCurrent).toHaveBeenCalledTimes(1);
  });

  it("late-clears a timed-out job even when generic cleanup rejects", async () => {
    const failure = new Error("late cleanup failed");
    const job = makeActiveJob();
    const cleanupGate = createDeferred<void>();
    const timer = {} as ReturnType<typeof setTimeout>;
    const jobs = {
      clearIfCurrent: vi.fn(),
      runCleanup: vi.fn(() => cleanupGate.promise),
    };
    const reportLateFailure = vi.fn();
    const result = await finishBeforeQuitCleanup({
      job,
      jobs,
      warnTimedOut: vi.fn(),
      reportLateFailure,
      scheduleTimeout: (callback) => {
        callback();
        return timer;
      },
      clearScheduledTimeout: vi.fn(),
    });

    expect(result).toEqual({
      timedOut: true,
      settlement: expect.any(Promise),
    });
    expect(jobs.clearIfCurrent).not.toHaveBeenCalled();

    cleanupGate.reject(failure);
    await expect(result.settlement).rejects.toBe(failure);

    expect(reportLateFailure).toHaveBeenCalledWith(job.id, failure);
    expect(jobs.clearIfCurrent).toHaveBeenCalledTimes(1);
    expect(jobs.clearIfCurrent).toHaveBeenCalledWith(job.id);
  });
});

function makeActiveJob(cleanup?: () => Promise<void>): ActiveJob {
  return {
    id: "job-1",
    kind: "gemma-analysis",
    abortController: new AbortController(),
    cleanup,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (!resolvePromise || !rejectPromise) {
    throw new Error("Failed to initialize deferred promise.");
  }
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
