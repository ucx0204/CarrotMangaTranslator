import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ipcEventContracts,
  jobControlIpcContracts,
} from "../src/shared/ipcContracts";
import type { ActiveJob } from "../src/main/jobs/activeJob";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import {
  BEFORE_QUIT_CLEANUP_TIMEOUT_MS,
  canReleaseInpaintingHistoryAfterQuitCleanup,
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

  it("aborts, completes cleanup, clears the job, then quits", async () => {
    const events: string[] = [];
    const job = makeActiveJob();
    job.abortController.signal.addEventListener("abort", () => {
      events.push("abort");
    });
    const neverTimesOut = createDeferred<void>();
    const jobs = {
      clearIfCurrent: vi.fn((jobId: string) => {
        events.push(`clear:${jobId}`);
      }),
      runCleanup: vi.fn(async (_job: ActiveJob, reason: string) => {
        events.push(`cleanup:${reason}`);
      }),
    };
    const quit = vi.fn(() => events.push("quit"));
    const warnTimedOut = vi.fn();
    const wait = vi.fn(async (timeoutMs: number) => {
      events.push(`wait:${timeoutMs}`);
      await neverTimesOut.promise;
    });

    const result = await finishBeforeQuitCleanup({
      job,
      jobs,
      quit,
      wait,
      warnTimedOut,
    });

    expect(events).toEqual([
      "abort",
      "cleanup:before-quit",
      `wait:${BEFORE_QUIT_CLEANUP_TIMEOUT_MS}`,
      `clear:${job.id}`,
      "quit",
    ]);
    expect(warnTimedOut).not.toHaveBeenCalled();
    expect(result).toEqual({ timedOut: false });
  });

  it("warns and quits after the timeout without waiting for cleanup", async () => {
    const events: string[] = [];
    const job = makeActiveJob();
    job.abortController.signal.addEventListener("abort", () => {
      events.push("abort");
    });
    const cleanupGate = createDeferred<void>();
    const cleanupFinished = createDeferred<void>();
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
    const quit = vi.fn(() => events.push("quit"));
    const warnTimedOut = vi.fn((jobId: string, timeoutMs: number) => {
      events.push(`timeout:${jobId}:${timeoutMs}`);
    });
    const wait = vi.fn(async (timeoutMs: number) => {
      events.push(`wait:${timeoutMs}`);
    });

    const result = await finishBeforeQuitCleanup({
      job,
      jobs,
      quit,
      wait,
      warnTimedOut,
    });

    expect(events).toEqual([
      "abort",
      "cleanup:start",
      `wait:${BEFORE_QUIT_CLEANUP_TIMEOUT_MS}`,
      `timeout:${job.id}:${BEFORE_QUIT_CLEANUP_TIMEOUT_MS}`,
      `clear:${job.id}`,
      "quit",
    ]);
    cleanupGate.resolve(undefined);
    await cleanupFinished.promise;
    expect(events.at(-1)).toBe("cleanup:end");
    expect(quit).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ timedOut: true });
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
