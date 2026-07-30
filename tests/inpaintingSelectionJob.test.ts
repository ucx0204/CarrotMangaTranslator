import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type {
  InpaintingJobContext,
  InpaintingJobRevisionStore,
} from "../src/main/jobs/inpaintingJobTypes";
import type { InpaintingJobRuntime } from "../src/main/jobs/inpaintingJobRuntime";
import type { InpaintingRevisionChange } from "../src/main/inpainting/inpaintingRevisionStore";
import type { InpaintingEngine } from "../src/main/inpainting/inpaintingEngine";
import type { AppPaths } from "../src/main/appPaths";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";

const chapterAId = "11111111-1111-4111-8111-111111111111";
const chapterBId = "22222222-2222-4222-8222-222222222222";
const pageA1Id = "33333333-3333-4333-8333-333333333333";
const pageA2Id = "44444444-4444-4444-8444-444444444444";
const pageB1Id = "55555555-5555-4555-8555-555555555555";

type InpaintingRuntimeHarness = {
  acquireEngine: ReturnType<
    typeof vi.fn<InpaintingJobRuntime["acquireEngine"]>
  >;
  inpaintPatternPage: ReturnType<
    typeof vi.fn<InpaintingJobRuntime["inpaintPatternPage"]>
  >;
  releaseEngine: ReturnType<typeof vi.fn<() => void>>;
  runEngine: ReturnType<typeof vi.fn<InpaintingEngine["inpaint"]>>;
  runtime: InpaintingJobRuntime;
};

describe("multi-chapter automatic inpainting jobs", () => {
  const chapters = new Map<string, ReturnType<typeof makeChapter>>();
  const revisionChanges: InpaintingRevisionChange[] = [];
  let harness: InpaintingRuntimeHarness;
  const send =
    vi.fn<
      (
        channel: string,
        event: import("../src/shared/jobTypes").JobEvent,
      ) => void
    >();

  beforeEach(() => {
    chapters.clear();
    revisionChanges.length = 0;
    chapters.set(
      chapterAId,
      makeChapter(chapterAId, "work-a", [
        makePage(pageA1Id, "a-1.png"),
        makePage(pageA2Id, "a-2.png"),
      ]),
    );
    chapters.set(
      chapterBId,
      makeChapter(chapterBId, "work-a", [makePage(pageB1Id, "b-1.png")]),
    );
    harness = createInpaintingRuntimeHarness(chapters);
  });

  it("processes ordered selections with one engine lease and aggregate progress", async () => {
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const result = await startInpaintingJob(
      makeContext(send),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [
          {
            chapterId: chapterAId,
            mode: "page-set",
            pageIds: [pageA2Id, pageA1Id],
          },
          { chapterId: chapterBId, mode: "all" },
        ],
      },
      harness.runtime,
    );

    expect(result.status).toBe("completed");
    expect(result.chapter).toBeUndefined();
    expect(result.chapters?.map((chapter) => chapter.id)).toEqual([
      chapterAId,
      chapterBId,
    ]);
    expect(result.pagesChanged).toBe(3);
    expect(harness.acquireEngine).toHaveBeenCalledTimes(1);
    expect(harness.acquireEngine).toHaveBeenCalledWith(
      expect.objectContaining({ computeGpuIndex: 2 }),
    );
    expect(harness.runEngine).toHaveBeenCalledTimes(3);
    expect(harness.releaseEngine).toHaveBeenCalledTimes(1);
    expect(
      harness.inpaintPatternPage.mock.calls.map(([page]) => page.name),
    ).toEqual(["a-1.png", "a-2.png", "b-1.png"]);

    const jobEvents = send.mock.calls.map((call) => call[1]);
    expect(jobEvents.at(-1)).toMatchObject({
      status: "completed",
      progressCurrent: 3,
      progressTotal: 3,
      pageTotal: 3,
    });
    expect(
      jobEvents
        .filter((event) => event.status === "running")
        .every((event) => event.progressTotal === 3 && event.pageTotal === 3),
    ).toBe(true);
  });

  it.each([
    {
      label: "duplicate chapters",
      selections: [
        { chapterId: chapterAId, mode: "all" as const },
        { chapterId: chapterAId, mode: "all" as const },
      ],
      error: /Duplicate chapter/,
    },
    {
      label: "duplicate pages",
      selections: [
        {
          chapterId: chapterAId,
          mode: "page-set" as const,
          pageIds: [pageA1Id, pageA1Id],
        },
      ],
      error: /Duplicate page/,
    },
    {
      label: "unknown pages",
      selections: [
        {
          chapterId: chapterAId,
          mode: "page-set" as const,
          pageIds: [pageB1Id],
        },
      ],
      error: /does not belong/,
    },
  ])(
    "rejects $label before acquiring an engine",
    async ({ selections, error }) => {
      const { startInpaintingJob } =
        await import("../src/main/jobs/inpaintingJobs");
      const result = await startInpaintingJob(
        makeContext(send),
        {
          mode: "selection-pattern",
          workId: "work-a",
          selections,
        },
        harness.runtime,
      );

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(error);
      expect(harness.acquireEngine).not.toHaveBeenCalled();
      expect(harness.inpaintPatternPage).not.toHaveBeenCalled();
    },
  );

  it("rejects selections spanning multiple works", async () => {
    chapters.set(
      chapterBId,
      makeChapter(chapterBId, "work-b", [makePage(pageB1Id, "b-1.png")]),
    );
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const result = await startInpaintingJob(
      makeContext(send),
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [
          { chapterId: chapterAId, mode: "all" },
          { chapterId: chapterBId, mode: "all" },
        ],
      },
      harness.runtime,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/same work/);
    expect(harness.acquireEngine).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: "failed" as const,
      error: new Error("second page failed"),
    },
    {
      status: "cancelled" as const,
      error: new DOMException("Aborted", "AbortError"),
    },
  ])(
    "returns one partial history transaction when a job is $status",
    async ({ status, error }) => {
      harness.inpaintPatternPage
        .mockImplementationOnce(async (page: MangaPage) => ({
          page: {
            ...page,
            inpaintedImagePath: `${page.imagePath}.inpainted.png`,
          },
          blocksErased: 1,
        }))
        .mockRejectedValueOnce(error);
      const { startInpaintingJob } =
        await import("../src/main/jobs/inpaintingJobs");

      const result = await startInpaintingJob(
        makeContext(send, revisionChanges),
        {
          mode: "selection-pattern",
          workId: "work-a",
          selections: [{ chapterId: chapterAId, mode: "all" }],
        },
        harness.runtime,
      );

      expect(result.status).toBe(status);
      expect(result.historyTransaction).toEqual({
        transactionId: HISTORY_TRANSACTION_ID,
      });
      expect(revisionChanges).toHaveLength(1);
      expect(revisionChanges[0]).toMatchObject({
        chapterId: chapterAId,
        pageId: pageA1Id,
      });
      if (status === "failed") {
        expect(harness.runtime.logError).toHaveBeenCalledWith(
          "Inpainting job failed",
          expect.objectContaining({ error }),
        );
      } else {
        expect(harness.runtime.logError).not.toHaveBeenCalled();
      }
    },
  );

  it("emits cancellation before refresh and waits for the runner to settle", async () => {
    const refreshedChapter = createDeferred<ChapterSnapshot>();
    vi.mocked(harness.runtime.openChapter).mockImplementation(
      async (chapterId) => {
        if (vi.mocked(harness.runtime.openChapter).mock.calls.length === 1) {
          return requireChapter(chapters, chapterId);
        }
        return refreshedChapter.promise;
      },
    );
    harness.inpaintPatternPage.mockImplementation(
      (_page: MangaPage, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const context = makeContext(send, revisionChanges);
    const terminalOrder: string[] = [];
    send.mockImplementation((_channel, event) => {
      if (event.status === "cancelled") {
        expect(context.jobs.hasActive).toBe(true);
        terminalOrder.push("cancelled");
      }
    });
    const clearIfCurrent = context.jobs.clearIfCurrent.bind(context.jobs);
    vi.spyOn(context.jobs, "clearIfCurrent").mockImplementation((jobId) => {
      terminalOrder.push("clear");
      clearIfCurrent(jobId);
    });
    const resultPromise = startInpaintingJob(
      context,
      {
        mode: "selection-pattern",
        workId: "work-a",
        selections: [{ chapterId: chapterAId, mode: "all" }],
      },
      harness.runtime,
    );
    await vi.waitFor(() => {
      expect(harness.inpaintPatternPage).toHaveBeenCalled();
      expect(context.jobs.current?.cleanup).toBeTypeOf("function");
    });
    const job = context.jobs.current;
    expect(job).not.toBeNull();
    job?.abortController.abort();

    const cleanupPromise = job
      ? context.jobs.runCleanup(job, "test-cancel")
      : Promise.resolve();
    await vi.waitFor(() => expect(terminalOrder).toEqual(["cancelled"]));
    expect(context.jobs.current).not.toBeNull();
    expect(harness.runtime.openChapter).toHaveBeenCalledTimes(2);

    refreshedChapter.resolve(requireChapter(chapters, chapterAId));
    await cleanupPromise;
    expect(context.jobs.current).toBeNull();
    await expect(resultPromise).resolves.toMatchObject({ status: "cancelled" });
    expect(terminalOrder).toEqual(["cancelled", "clear"]);
  });
});

function createInpaintingRuntimeHarness(
  chapters: Map<string, ChapterSnapshot>,
): InpaintingRuntimeHarness {
  const runEngine = vi.fn<InpaintingEngine["inpaint"]>(async () => undefined);
  const releaseEngine = vi.fn<() => void>();
  const acquireEngine = vi.fn<InpaintingJobRuntime["acquireEngine"]>(
    async () => ({
      engine: {
        model: "flux-klein",
        backend: "cuda-native",
        runtimePath: "C:\\runtime\\flux.exe",
        runRootDir: "C:\\runtime\\runs",
        inpaint: runEngine,
        dispose: async () => undefined,
      },
      release: releaseEngine,
    }),
  );
  const inpaintPatternPage = vi.fn<InpaintingJobRuntime["inpaintPatternPage"]>(
    async (page, options) => {
      await options?.inpaintingEngine?.inpaint(
        Buffer.alloc(4),
        1,
        1,
        new Uint8Array(1).fill(1),
        [{ x: 0, y: 0, w: 1, h: 1 }],
      );
      return {
        page: {
          ...page,
          inpaintedImagePath: `${page.imagePath}.inpainted.png`,
        },
        blocksErased: 1,
      };
    },
  );
  const settings = resolveDefaultAppSettings();
  settings.hardware = {
    ...settings.hardware,
    computeGpuIndex: 2,
  };
  settings.inpainting = { model: "flux-klein" };
  const savePages = vi.fn<InpaintingJobRuntime["savePages"]>(
    async (chapterId, pages) => {
      const chapter = requireChapter(chapters, chapterId);
      const updates = new Map(pages.map((page) => [page.id, page]));
      const saved: ChapterSnapshot = {
        ...chapter,
        pages: chapter.pages.map((page) => updates.get(page.id) ?? page),
      };
      chapters.set(chapterId, saved);
      return saved;
    },
  );
  const runtime: InpaintingJobRuntime = {
    acquireEngine,
    emitEvent: (jobs, mainWindow, event) => {
      if (jobs.current?.id !== event.id) {
        return;
      }
      jobs.updateLastEvent(event.id, event);
      mainWindow?.webContents.send("job:event", event);
    },
    getSettings: vi.fn(async () => settings),
    inpaintDrawnPage: vi.fn(async () => {
      throw new Error("drawn inpainting should not run");
    }),
    inpaintPatternPage,
    logError: vi.fn(),
    openChapter: vi.fn(async (chapterId) =>
      requireChapter(chapters, chapterId),
    ),
    savePages,
  };
  return {
    acquireEngine,
    inpaintPatternPage,
    releaseEngine,
    runEngine,
    runtime,
  };
}

function requireChapter(
  chapters: ReadonlyMap<string, ChapterSnapshot>,
  chapterId: string,
): ChapterSnapshot {
  const chapter = chapters.get(chapterId);
  if (!chapter) {
    throw new Error(`missing chapter: ${chapterId}`);
  }
  return chapter;
}

function makePage(id: string, name: string): MangaPage {
  return {
    id,
    name,
    imagePath: `C:\\library\\${name}`,
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 100,
    blocks: [
      {
        id: `${id}-block`,
        type: "nonsolid",
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        sourceText: "source",
        translatedText: "translated",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 16,
        lineHeight: 1.2,
        textAlign: "left",
        textColor: "#000000",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
    ],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChapter(id: string, workId: string, pages: MangaPage[]) {
  return {
    id,
    workId,
    title: id,
    sourceKind: "images" as const,
    status: "completed" as const,
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const HISTORY_TRANSACTION_ID = "66666666-6666-4666-8666-666666666666";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Failed to create deferred promise.");
  }
  return { promise, resolve: resolvePromise };
}

function makeContext(
  send: (
    channel: string,
    event: import("../src/shared/jobTypes").JobEvent,
  ) => void,
  revisionChanges: InpaintingRevisionChange[] = [],
): InpaintingJobContext {
  const mainWindow = { webContents: { send } };
  return {
    appPaths: makeAppPaths(),
    jobs: new ActiveJobStore({ error: vi.fn(), info: vi.fn() }),
    getMainWindow: () => mainWindow,
    decodeImage: async () => {
      throw new Error("decode fallback should not run");
    },
    inpaintingRevisionStore: makeRevisionStore(revisionChanges),
  };
}

function makeAppPaths(): AppPaths {
  return {
    isPackaged: false,
    repoRoot: "C:\\repo",
    executableDir: "C:\\repo",
    resourcesDir: "C:\\repo\\resources",
    dataRoot: "C:\\repo",
    settingsPath: "C:\\repo\\settings.json",
    libraryDir: "C:\\repo\\library",
    fontsDir: "C:\\repo\\fonts",
    logsDir: "C:\\repo\\logs",
    logFile: "C:\\repo\\logs\\app.log",
    runtimeDir: "C:\\repo\\runtime",
    toolsDir: "C:\\repo\\tools",
    ocrRuntimeDir: "C:\\repo\\ocr",
    llamaRuntimeDir: "C:\\repo\\llama",
    llamaServerPath: "C:\\repo\\llama\\server.exe",
  };
}

function makeRevisionStore(
  changes: InpaintingRevisionChange[],
): InpaintingJobRevisionStore {
  return {
    beginTransaction: () => HISTORY_TRANSACTION_ID,
    addChange: (_transactionId: string, change: InpaintingRevisionChange) => {
      changes.push(change);
      return true;
    },
    removeChange: async (
      _transactionId: string,
      chapterId: string,
      pageId: string,
    ) => {
      const index = changes.findIndex(
        (change) => change.chapterId === chapterId && change.pageId === pageId,
      );
      if (index >= 0) {
        changes.splice(index, 1);
      }
    },
    discardIfEmpty: () => undefined,
    getReference: () =>
      changes.length > 0
        ? { transactionId: HISTORY_TRANSACTION_ID }
        : undefined,
    getRetainedArtifactPaths: () =>
      changes.flatMap((change) =>
        [change.beforePath, change.afterPath].filter((path): path is string =>
          Boolean(path),
        ),
      ),
  } satisfies InpaintingJobRevisionStore;
}
