import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import { registerJobControlIpc } from "../src/main/ipc/jobControlIpc";
import {
  startAnalysisJob,
  translateRegionJob,
} from "../src/main/jobs/translationJobs";
import { jobControlIpcContracts } from "../src/shared/ipcContracts";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { JobEvent } from "../src/shared/jobTypes";

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown> | unknown;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { handle: electronMock.handle },
}));

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
});

describe("translation immediate cancellation", () => {
  it("keeps cancel cleanup pending while page resolution finishes the outer job", async () => {
    const chapter = makeChapter();
    const resolution = createDeferred<{
      chapter: ChapterSnapshot;
      pages: MangaPage[];
    }>();
    const jobs = new ActiveJobStore();
    const events: string[] = [];
    const runtime: NonNullable<Parameters<typeof startAnalysisJob>[2]> = {
      resolvePagesForRun: vi.fn(() => resolution.promise),
      runResolvedAnalysisJob: vi.fn(),
      handleAnalysisJobError: vi.fn(async ({ emit, id }) => {
        emit(cancelledEvent(id));
        return { status: "cancelled" as const, chapter };
      }),
    };

    const startPromise = startAnalysisJob(
      makeContext(jobs, events),
      { chapterId: chapter.id, runMode: "all" },
      runtime,
    );
    const job = requireCurrentJob(jobs);
    job.abortController.abort();

    let cancelSettled = false;
    const cancelPromise = jobs.runCleanup(job, "cancel").then(() => {
      cancelSettled = true;
    });
    await Promise.resolve();
    expect(cancelSettled).toBe(false);

    resolution.resolve({ chapter, pages: chapter.pages });
    await cancelPromise;
    const result = await startPromise;

    expect(runtime.runResolvedAnalysisJob).not.toHaveBeenCalled();
    expect(result.status).toBe("cancelled");
    expect(events).toContain("cancelled");
    expect(jobs.current).toBeNull();
  });

  it("actual cancel IPC waits for late resource cleanup, terminal event, and active clear", async () => {
    const chapter = makeChapter();
    const jobs = new ActiveJobStore();
    const runnerEntered = createDeferred<void>();
    const allowRegistration = createDeferred<void>();
    const resourceGate = createDeferred<void>();
    const resourceCleanup = vi.fn(() => resourceGate.promise);
    const order: string[] = [];
    const clearIfCurrent = jobs.clearIfCurrent.bind(jobs);
    vi.spyOn(jobs, "clearIfCurrent").mockImplementation((jobId) => {
      order.push("clear");
      clearIfCurrent(jobId);
    });
    const mainWindow = makeWindow(jobs, order);
    registerJobControlIpc({ jobs, getMainWindow: () => mainWindow });

    const runtime: NonNullable<Parameters<typeof startAnalysisJob>[2]> = {
      resolvePagesForRun: vi.fn().mockResolvedValue({
        chapter,
        pages: chapter.pages,
      }),
      runResolvedAnalysisJob: vi.fn(async ({ registerResourceCleanup }) => {
        runnerEntered.resolve(undefined);
        await allowRegistration.promise;
        registerResourceCleanup(resourceCleanup);
        throw new DOMException("Aborted", "AbortError");
      }),
      handleAnalysisJobError: vi.fn(async ({ emit, id }) => {
        emit(cancelledEvent(id));
        return { status: "cancelled" as const, chapter };
      }),
    };

    const startPromise = startAnalysisJob(
      {
        jobs,
        getMainWindow: () => mainWindow,
        decodeImage: vi.fn(),
      },
      { chapterId: chapter.id, runMode: "all" },
      runtime,
    );
    await runnerEntered.promise;

    const handler = electronMock.handlers.get(
      jobControlIpcContracts.cancelJob.channel,
    );
    if (!handler) throw new Error("Cancel job IPC handler was not registered.");
    let responseSettled = false;
    const invocation = Promise.resolve(
      handler({
        sender: { id: 17 },
        senderFrame: { url: "http://127.0.0.1:5173/" },
      } as IpcMainInvokeEvent),
    ).then((value) => {
      responseSettled = true;
      order.push("response");
      return value;
    });

    await Promise.resolve();
    expect(requireCurrentJob(jobs).abortController.signal.aborted).toBe(true);
    expect(responseSettled).toBe(false);
    allowRegistration.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(resourceCleanup).toHaveBeenCalledTimes(1);
    expect(responseSettled).toBe(false);

    await startPromise;
    expect(order).toEqual(["cancelling", "cancelled", "clear"]);
    expect(responseSettled).toBe(false);

    resourceGate.resolve(undefined);
    await expect(invocation).resolves.toEqual({ cancelled: true });
    expect(order).toEqual(["cancelling", "cancelled", "clear", "response"]);
    expect(jobs.current).toBeNull();
  });

  it("does not self-clean registered resources on normal completion", async () => {
    const chapter = makeChapter();
    const jobs = new ActiveJobStore();
    const runCleanup = vi.spyOn(jobs, "runCleanup");
    const resourceCleanup = vi.fn(async () => undefined);
    const runtime: NonNullable<Parameters<typeof startAnalysisJob>[2]> = {
      resolvePagesForRun: vi.fn().mockResolvedValue({
        chapter,
        pages: chapter.pages,
      }),
      runResolvedAnalysisJob: vi.fn(async ({ registerResourceCleanup }) => {
        registerResourceCleanup(resourceCleanup);
        return { status: "completed" as const, chapter, warnings: [] };
      }),
      handleAnalysisJobError: vi.fn(),
    };

    await expect(
      startAnalysisJob(
        makeContext(jobs, []),
        {
          chapterId: chapter.id,
          runMode: "all",
          timingSession: {
            id: "99999999-9999-4999-8999-999999999999",
            startedAtEpochMs: 1_000,
          },
        },
        runtime,
      ),
    ).resolves.toMatchObject({ status: "completed" });

    expect(resourceCleanup).not.toHaveBeenCalled();
    expect(runCleanup).not.toHaveBeenCalled();
    expect(jobs.current).toBeNull();
  });

  it("keeps region cancellation pending until the region outer job finishes", async () => {
    const chapter = makeChapter();
    const jobs = new ActiveJobStore();
    const runnerEntered = createDeferred<void>();
    const runnerGate = createDeferred<void>();
    const runtime: NonNullable<Parameters<typeof translateRegionJob>[2]> = {
      runRegionTranslationJob: vi.fn(async () => {
        runnerEntered.resolve(undefined);
        await runnerGate.promise;
        throw new DOMException("Aborted", "AbortError");
      }),
      handleRegionJobError: vi.fn(async ({ emit, id }) => {
        emit(cancelledEvent(id));
        return {
          status: "cancelled" as const,
          chapter,
          pageId: chapter.pages[0]?.id,
        };
      }),
    };

    const startPromise = translateRegionJob(
      makeContext(jobs, []),
      {
        chapterId: chapter.id,
        pageId: firstPage(chapter).id,
        bbox: { x: 100, y: 100, w: 400, h: 400 },
      },
      runtime,
    );
    await runnerEntered.promise;
    const job = requireCurrentJob(jobs);
    job.abortController.abort();

    let cancelSettled = false;
    const cancelPromise = jobs.runCleanup(job, "cancel").then(() => {
      cancelSettled = true;
    });
    await Promise.resolve();
    expect(cancelSettled).toBe(false);

    runnerGate.resolve(undefined);
    await cancelPromise;
    await expect(startPromise).resolves.toMatchObject({ status: "cancelled" });
    expect(jobs.current).toBeNull();
  });
});

function makeContext(jobs: ActiveJobStore, events: string[]) {
  return {
    jobs,
    getMainWindow: () => makeWindow(jobs, events),
    decodeImage: vi.fn(),
  };
}

function makeWindow(jobs: ActiveJobStore, events: string[]): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:5173/",
      id: 17,
      send: (_channel: string, event: JobEvent) => {
        if (event.status === "cancelled" || event.status === "cancelling") {
          expect(jobs.hasActive).toBe(true);
        }
        events.push(event.status);
      },
    },
  } as BrowserWindow;
}

function cancelledEvent(id: string): JobEvent {
  return {
    id,
    kind: "gemma-analysis",
    status: "cancelled",
    progressText: "작업이 취소됨",
    phase: "cancelled",
  };
}

function requireCurrentJob(jobs: ActiveJobStore) {
  const job = jobs.current;
  if (!job) throw new Error("Expected an active job.");
  return job;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function firstPage(chapter: ChapterSnapshot): MangaPage {
  const page = chapter.pages[0];
  if (!page) throw new Error("Expected a chapter page.");
  return page;
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "C:/001.png",
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [],
    analysisStatus: "idle",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function makeChapter(): ChapterSnapshot {
  const pages = [makePage()];
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}
