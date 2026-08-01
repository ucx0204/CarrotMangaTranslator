import { describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import type { BubbleLayoutRunner } from "../src/main/inpainting/bubbleLayoutRunner";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { InpaintingJobContext } from "../src/main/jobs/inpaintingJobTypes";
import type { InpaintingJobRuntime } from "../src/main/jobs/inpaintingJobRuntime";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";

const CHAPTER_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const DONE_BLOCK_ID = "block-done";
const PENDING_BLOCK_ID = "block-pending";

describe("pending Bubble inpainting retry", () => {
  it("infers Bubble postprocess and limits its prepass to unfinished blocks", async () => {
    const page = makePage();
    let chapter = makeChapter(page);
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async () => ({
      patches: [DONE_BLOCK_ID, PENDING_BLOCK_ID].map((blockId) => ({
        blockId,
        renderBbox: { x: 100, y: 100, w: 200, h: 200 },
        renderBboxSpace: "normalized_1000" as const,
        bubbleLayout: {
          version: 1 as const,
          direction: "horizontal" as const,
          confidence: 1,
          origin: "detected" as const,
          modelId: "test-runner",
          sourceImageRevision: "test-source-revision",
          insetRatio: 0.08,
          regions: [
            {
              spans: [
                {
                  blockStart: 0.1,
                  blockEnd: 0.9,
                  inlineStart: 0.1,
                  inlineEnd: 0.9,
                },
              ],
            },
          ],
        },
      })),
    }));
    const inpaintPatternPage = vi.fn<
      InpaintingJobRuntime["inpaintPatternPage"]
    >(async (preparedPage, options) => {
      expect(options?.excludedBlockIds).toEqual([DONE_BLOCK_ID]);
      expect(options?.bubbleLayoutConstraintBlockIds).toEqual([
        PENDING_BLOCK_ID,
      ]);
      return {
        page: {
          ...preparedPage,
          inpaintedImagePath: `${page.imagePath}.done.png`,
        },
        blocksErased: 1,
        blocksIncomplete: 0,
        erasedBlockIds: [PENDING_BLOCK_ID],
        incompleteBlockIds: [],
      };
    });
    const runtime = makeRuntime(
      () => chapter,
      (nextChapter) => {
        chapter = nextChapter;
      },
      runPage,
      inpaintPatternPage,
    );
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(),
      { chapterId: CHAPTER_ID, mode: "chapter-pattern-pending" },
      runtime,
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(runPage).toHaveBeenCalledTimes(2);
    expect(runPage.mock.calls[0]?.[0].sharedOwnershipGapPx).toBeUndefined();
    expect(result.chapter?.pages[0]?.translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "completed",
      erasedBlockIds: [DONE_BLOCK_ID, PENDING_BLOCK_ID],
    });
    expect(result.chapter?.pages[0]?.blocks[0]?.bubbleLayout).toBeUndefined();
    expect(result.chapter?.pages[0]?.blocks[1]?.bubbleLayout).toBeDefined();
  });

  it("rejects mixed pending completion workflows instead of reporting completion", async () => {
    const bubblePage = makePage();
    const erasePage: MangaPage = {
      ...structuredClone(bubblePage),
      id: "33333333-3333-4333-8333-333333333333",
      inpaintedImagePath: undefined,
      translationCompletion: {
        workflow: "erase-original",
        status: "pending",
      },
    };
    let chapter: ChapterSnapshot = {
      ...makeChapter(bubblePage),
      pageOrder: [bubblePage.id, erasePage.id],
      pages: [bubblePage, erasePage],
    };
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async () => ({
      patches: [],
    }));
    const inpaintPatternPage = vi.fn<
      InpaintingJobRuntime["inpaintPatternPage"]
    >(async (page) => ({ page, blocksErased: 0 }));
    const runtime = makeRuntime(
      () => chapter,
      (nextChapter) => {
        chapter = nextChapter;
      },
      runPage,
      inpaintPatternPage,
    );
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(),
      {
        mode: "selection-pattern",
        workId: chapter.workId,
        selections: [{ chapterId: CHAPTER_ID, mode: "all" }],
      },
      runtime,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/워크플로|workflow/i);
    expect(runtime.acquireEngine).not.toHaveBeenCalled();
    expect(inpaintPatternPage).not.toHaveBeenCalled();
  });
});

function makeRuntime(
  getChapter: () => ChapterSnapshot,
  setChapter: (chapter: ChapterSnapshot) => void,
  runPage: BubbleLayoutRunner["runPage"],
  inpaintPatternPage: InpaintingJobRuntime["inpaintPatternPage"],
): InpaintingJobRuntime {
  const savePages = vi.fn<InpaintingJobRuntime["savePages"]>(
    async (_chapterId, pages) => {
      const updates = new Map(pages.map((item) => [item.id, item]));
      const saved: ChapterSnapshot = {
        ...getChapter(),
        pages: getChapter().pages.map((item) => updates.get(item.id) ?? item),
      };
      setChapter(saved);
      return saved;
    },
  );
  return {
    acquireEngine: vi.fn(async () => ({
      engine: {
        model: "flux-klein",
        backend: "cpu",
        runtimePath: "C:\\runtime\\runner.exe",
        runRootDir: "C:\\runtime\\runs",
        inpaint: vi.fn(),
        dispose: vi.fn(),
      },
      release: vi.fn(),
    })) as InpaintingJobRuntime["acquireEngine"],
    createBubbleLayoutRunner: () => ({ runPage }),
    emitEvent: (jobs, _window, event) => jobs.updateLastEvent(event.id, event),
    getSettings: vi.fn(async () => resolveDefaultAppSettings()),
    inpaintDrawnPage: vi.fn(async () => {
      throw new Error("unexpected drawn inpainting");
    }),
    inpaintPatternPage,
    logError: vi.fn(),
    openChapter: vi.fn(async () => getChapter()),
    savePages,
  };
}

function makeContext(): InpaintingJobContext {
  return {
    appPaths: { dataRoot: "C:\\data" } as AppPaths,
    jobs: new ActiveJobStore({ error: vi.fn(), info: vi.fn() }),
    getMainWindow: () => null,
    decodeImage: async () => null,
  };
}

function makeChapter(page: MangaPage): ChapterSnapshot {
  return {
    id: CHAPTER_ID,
    workId: "work-1",
    title: "chapter",
    sourceKind: "images",
    status: "partial",
    pageOrder: [PAGE_ID],
    pages: [page],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePage(): MangaPage {
  const block = {
    id: DONE_BLOCK_ID,
    type: "nonsolid" as const,
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal" as const,
    renderDirection: "horizontal" as const,
    fontSizePx: 16,
    lineHeight: 1.2,
    textAlign: "left" as const,
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
  return {
    id: PAGE_ID,
    name: "page.png",
    imagePath: "C:\\library\\page.png",
    inpaintedImagePath: "C:\\library\\page.partial.png",
    dataUrl: "data:image/png;base64,AA==",
    width: 1000,
    height: 1000,
    blocks: [block, { ...structuredClone(block), id: PENDING_BLOCK_ID }],
    analysisStatus: "completed",
    translationCompletion: {
      workflow: "bubble-layout",
      status: "pending",
      erasedBlockIds: [DONE_BLOCK_ID],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
