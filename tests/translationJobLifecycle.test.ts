import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import { completeAnalysisJob } from "../src/main/jobs/translationJobRunners";
import { startAnalysisJob } from "../src/main/jobs/translationJobs";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { JobEvent } from "../src/shared/jobTypes";

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

describe("translation job lifecycle", () => {
  it("emits the cancelled terminal event before clearing the active job", async () => {
    const chapter = makeChapter();
    const runtime: NonNullable<Parameters<typeof startAnalysisJob>[2]> = {
      resolvePagesForRun: vi.fn().mockResolvedValue({
        chapter,
        pages: chapter.pages,
      }),
      runResolvedAnalysisJob: vi
        .fn()
        .mockRejectedValue(new DOMException("Aborted", "AbortError")),
      handleAnalysisJobError: vi.fn(async ({ emit, id }) => {
        await Promise.resolve();
        emit({
          id,
          kind: "gemma-analysis",
          status: "cancelled",
          progressText: "작업이 취소됨",
          phase: "cancelled",
        });
        return { status: "cancelled" as const };
      }),
    };
    const terminalOrder: string[] = [];
    const jobs = new ActiveJobStore();
    const clearIfCurrent = jobs.clearIfCurrent.bind(jobs);
    vi.spyOn(jobs, "clearIfCurrent").mockImplementation((jobId) => {
      terminalOrder.push("clear");
      clearIfCurrent(jobId);
    });
    const mainWindow = makeJobEventWindow(jobs, terminalOrder);

    const result = await startAnalysisJob(
      {
        jobs,
        getMainWindow: () => mainWindow,
        decodeImage: vi.fn(),
      },
      { chapterId: chapter.id, runMode: "all" },
      runtime,
    );

    expect(result).toEqual({ status: "cancelled" });
    expect(terminalOrder).toEqual(["cancelled", "clear"]);
    expect(jobs.current).toBeNull();
  });

  it("emits failed when the persisted target pages are only partially complete", async () => {
    const firstPage = {
      ...makePage(),
      analysisStatus: "completed" as const,
    };
    const secondPage = {
      ...makePage(),
      id: "page-2",
      name: "002.png",
      imagePath: "C:/002.png",
      analysisStatus: "failed" as const,
      lastError: "response truncated",
    };
    const requestedChapter = makeChapter([firstPage, secondPage]);
    const persistedChapter = {
      ...requestedChapter,
      status: "partial" as const,
    };
    const emit = vi.fn();

    const result = await completeAnalysisJob(
      "job-partial",
      emit,
      { chapterId: requestedChapter.id, runMode: "all" },
      {
        chapter: requestedChapter,
        pages: requestedChapter.pages,
      },
      {
        pages: requestedChapter.pages,
        warnings: ["page 2 failed"],
      } as Parameters<typeof completeAnalysisJob>[4],
      vi.fn().mockResolvedValue(persistedChapter),
    );

    expect(result).toMatchObject({
      status: "failed",
      chapter: persistedChapter,
      warnings: ["page 2 failed"],
    });
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        phase: "failed",
      }),
    );
  });

  it("does not emit completed before the persisted chapter can be reopened", async () => {
    const chapter = makeChapter();
    const emit = vi.fn();

    await expect(
      completeAnalysisJob(
        "job-open-failed",
        emit,
        { chapterId: chapter.id, runMode: "all" },
        { chapter, pages: chapter.pages },
        {
          pages: chapter.pages,
          warnings: [],
        } as Parameters<typeof completeAnalysisJob>[4],
        vi.fn().mockRejectedValue(new Error("chapter read failed")),
      ),
    ).rejects.toThrow("chapter read failed");
    expect(emit).not.toHaveBeenCalled();
  });

  it("fails a combined workflow when its pending completion receipt was not persisted", async () => {
    const page = { ...makePage(), analysisStatus: "completed" as const };
    const chapter = makeChapter([page]);
    const emit = vi.fn();

    const result = await completeAnalysisJob(
      "job-missing-receipt",
      emit,
      {
        chapterId: chapter.id,
        runMode: "all",
        completionWorkflow: "bubble-layout",
      },
      { chapter, pages: chapter.pages },
      { pages: chapter.pages, warnings: [] } as Parameters<
        typeof completeAnalysisJob
      >[4],
      vi.fn().mockResolvedValue(chapter),
    );

    expect(result.status).toBe("failed");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", phase: "failed" }),
    );
  });

  it("accepts a combined workflow only after its pending receipt is persisted", async () => {
    const page = {
      ...makePage(),
      analysisStatus: "completed" as const,
      translationCompletion: {
        workflow: "bubble-layout" as const,
        status: "pending" as const,
      },
    };
    const chapter = makeChapter([page]);
    const emit = vi.fn();

    const result = await completeAnalysisJob(
      "job-persisted-receipt",
      emit,
      {
        chapterId: chapter.id,
        runMode: "all",
        completionWorkflow: "bubble-layout",
      },
      { chapter, pages: chapter.pages },
      { pages: chapter.pages, warnings: [] } as Parameters<
        typeof completeAnalysisJob
      >[4],
      vi.fn().mockResolvedValue(chapter),
    );

    expect(result.status).toBe("completed");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", phase: "done" }),
    );
  });

  it.each([
    {
      name: "a deleted single page",
      request: {
        chapterId: "chapter-1",
        runMode: "single-page" as const,
        pageId: "deleted-page",
      },
      resolvedPages: [],
    },
    {
      name: "a foreign page in a page set",
      request: {
        chapterId: "chapter-1",
        runMode: "page-set" as const,
        pageIds: ["page-1", "foreign-page"],
      },
      resolvedPages: [makePage()],
    },
    {
      name: "duplicate resolved pages",
      request: {
        chapterId: "chapter-1",
        runMode: "page-set" as const,
        pageIds: ["page-1", "page-2"],
      },
      resolvedPages: [makePage(), makePage()],
    },
  ])(
    "fails instead of completing when resolution returns $name",
    async ({ request, resolvedPages }) => {
      const chapter = makeChapter([
        makePage(),
        { ...makePage(), id: "page-2", name: "002.png" },
      ]);
      const runtime = makeSelectionValidationRuntime(chapter, resolvedPages);
      const jobs = new ActiveJobStore();
      const mainWindow = makeJobEventWindow(jobs, []);

      const result = await startAnalysisJob(
        {
          jobs,
          getMainWindow: () => mainWindow,
          decodeImage: vi.fn(),
        },
        request,
        runtime,
      );

      expect(result).toMatchObject({
        status: "failed",
        error: expect.stringContaining("저장 상태와 일치하지 않습니다"),
      });
      expect(runtime.runResolvedAnalysisJob).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "an empty page set",
      pageIds: [],
      error: "하나 이상 선택",
    },
    {
      name: "duplicate page IDs",
      pageIds: ["page-1", "page-1"],
      error: "중복된 페이지 ID",
    },
    {
      name: "too many page IDs",
      pageIds: Array.from({ length: 2_001 }, (_, index) => `page-${index}`),
      error: "최대 2000개",
    },
  ])("rejects $name before resolving pages", async ({ pageIds, error }) => {
    const chapter = makeChapter();
    const runtime = makeSelectionValidationRuntime(chapter, chapter.pages);
    const jobs = new ActiveJobStore();
    const mainWindow = makeJobEventWindow(jobs, []);

    const result = await startAnalysisJob(
      {
        jobs,
        getMainWindow: () => mainWindow,
        decodeImage: vi.fn(),
      },
      { chapterId: chapter.id, runMode: "page-set", pageIds },
      runtime,
    );

    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining(error),
    });
    expect(runtime.resolvePagesForRun).not.toHaveBeenCalled();
    expect(runtime.runResolvedAnalysisJob).not.toHaveBeenCalled();
  });

  it("accepts the exact requested page set resolved in chapter order", async () => {
    const firstPage = makePage();
    const secondPage = { ...makePage(), id: "page-2", name: "002.png" };
    const chapter = makeChapter([firstPage, secondPage]);
    const runtime = makeSelectionValidationRuntime(chapter, [
      firstPage,
      secondPage,
    ]);
    vi.mocked(runtime.runResolvedAnalysisJob).mockResolvedValue({
      status: "completed",
      chapter,
      warnings: [],
    });
    const jobs = new ActiveJobStore();
    const mainWindow = makeJobEventWindow(jobs, []);

    const result = await startAnalysisJob(
      {
        jobs,
        getMainWindow: () => mainWindow,
        decodeImage: vi.fn(),
      },
      {
        chapterId: chapter.id,
        runMode: "page-set",
        pageIds: [secondPage.id, firstPage.id],
      },
      runtime,
    );

    expect(result.status).toBe("completed");
    expect(runtime.runResolvedAnalysisJob).toHaveBeenCalledOnce();
  });
});

function makeSelectionValidationRuntime(
  chapter: ChapterSnapshot,
  pages: MangaPage[],
): NonNullable<Parameters<typeof startAnalysisJob>[2]> {
  return {
    resolvePagesForRun: vi.fn().mockResolvedValue({ chapter, pages }),
    runResolvedAnalysisJob: vi.fn(),
    handleAnalysisJobError: vi.fn(async ({ error }) => ({
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
    })),
  };
}

function makeJobEventWindow(
  jobs: ActiveJobStore,
  terminalOrder: string[],
): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, event: JobEvent) => {
        expect(jobs.hasActive).toBe(true);
        terminalOrder.push(event.status);
      },
    },
  } as BrowserWindow;
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "C:/001.png",
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus: "idle",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function makeChapter(pages: MangaPage[] = [makePage()]): ChapterSnapshot {
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
