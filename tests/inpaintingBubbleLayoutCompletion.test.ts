import { describe, expect, it, vi } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import type { AppPaths } from "../src/main/appPaths";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { InpaintingJobContext } from "../src/main/jobs/inpaintingJobTypes";
import type { InpaintingJobRuntime } from "../src/main/jobs/inpaintingJobRuntime";
import type { BubbleLayoutRunner } from "../src/main/inpainting/bubbleLayoutRunner";
import type { BubbleLayout } from "../src/shared/bubbleLayout";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";

const CHAPTER_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const BLOCK_ID = "block-1";
const SECOND_BLOCK_ID = "block-2";

describe("required Bubble workflow completion", () => {
  it("completes when Bubble runs successfully and finds no balloon", async () => {
    const page = makePendingPage();
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async () => ({
      patches: [],
    }));

    const result = await runWorkflow(page, runPage);

    expect(result).toMatchObject({
      status: "completed",
      pagesChanged: 1,
      blocksErased: 1,
    });
    expect(runPage).toHaveBeenCalledTimes(2);
    expect(result.chapter?.pages[0]).toHaveProperty("inpaintedImagePath");
    expect(result.chapter?.pages[0]?.translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "completed",
    });
  });

  it("does not require final layout for a block the prepass did not classify as a balloon", async () => {
    const page = makePendingPage();
    const firstBlock = page.blocks[0];
    if (!firstBlock) throw new Error("expected block");
    page.blocks.push({
      ...structuredClone(firstBlock),
      id: SECOND_BLOCK_ID,
      bbox: { x: 500, y: 500, w: 180, h: 200 },
    });
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(
      async ({ failureMode }) => ({
        patches:
          failureMode === "required"
            ? [
                {
                  blockId: BLOCK_ID,
                  renderBbox: { x: 100, y: 120, w: 300, h: 260 },
                  renderBboxSpace: "normalized_1000",
                  bubbleLayout: makeBubbleLayout(),
                },
              ]
            : [],
      }),
    );

    const result = await runWorkflow(page, runPage);

    expect(result.status).toBe("completed");
    expect(result.chapter?.pages[0]?.translationCompletion?.status).toBe(
      "completed",
    );
    expect(result.chapter?.pages[0]?.blocks[0]?.bubbleLayout).toEqual(
      makeBubbleLayout(),
    );
    expect(result.chapter?.pages[0]?.blocks[1]?.bubbleLayout).toBeUndefined();
  });

  it("completes ordinary auto inpainting when Bubble omits a non-balloon block", async () => {
    const page = makePendingPage();
    delete page.translationCompletion;
    const firstBlock = page.blocks[0];
    if (!firstBlock) throw new Error("expected block");
    page.blocks.push({
      ...structuredClone(firstBlock),
      id: SECOND_BLOCK_ID,
      bbox: { x: 500, y: 500, w: 180, h: 200 },
    });
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(
      async ({ failureMode }) => ({
        patches:
          failureMode === "required"
            ? [
                {
                  blockId: BLOCK_ID,
                  renderBbox: { x: 100, y: 120, w: 300, h: 260 },
                  renderBboxSpace: "normalized_1000",
                  bubbleLayout: makeBubbleLayout(),
                },
              ]
            : [],
      }),
    );

    const result = await runWorkflow(page, runPage);

    expect(result).toMatchObject({
      status: "completed",
      pagesChanged: 1,
      blocksErased: 1,
    });
    expect(result.chapter?.pages[0]).toHaveProperty("inpaintedImagePath");
    expect(result.chapter?.pages[0]?.blocks[1]?.bubbleLayout).toBeUndefined();
  });

  it.each(["flux-klein", "lama-manga"] as const)(
    "completes with %s when the successful final pass returns a sparse result",
    async (model) => {
      const page = makePendingPage();
      const firstBlock = page.blocks[0];
      if (!firstBlock) throw new Error("expected block");
      page.blocks.push({
        ...structuredClone(firstBlock),
        id: SECOND_BLOCK_ID,
        bbox: { x: 500, y: 500, w: 180, h: 200 },
      });
      const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(
        async ({ failureMode }) => ({
          patches:
            failureMode === "best-effort"
              ? [
                  {
                    blockId: BLOCK_ID,
                    renderBbox: { x: 100, y: 120, w: 300, h: 260 },
                    renderBboxSpace: "normalized_1000",
                    bubbleLayout: makeBubbleLayout(),
                  },
                  {
                    blockId: SECOND_BLOCK_ID,
                    renderBbox: { x: 500, y: 500, w: 180, h: 200 },
                    renderBboxSpace: "normalized_1000",
                    bubbleLayout: makeBubbleLayout(),
                  },
                ]
              : [
                  {
                    blockId: BLOCK_ID,
                    renderBbox: { x: 100, y: 120, w: 300, h: 260 },
                    renderBboxSpace: "normalized_1000",
                    bubbleLayout: makeBubbleLayout(),
                  },
                ],
        }),
      );

      const result = await runWorkflow(page, runPage, model);

      expect(result).toMatchObject({
        status: "completed",
        pagesChanged: 1,
        blocksErased: 1,
      });
      expect(result.chapter?.pages[0]).toHaveProperty("inpaintedImagePath");
      expect(result.chapter?.pages[0]?.blocks[1]?.bubbleLayout).toBeUndefined();
    },
  );

  it("does not require Bubble output for a block with empty translated text", async () => {
    const page = makePendingPage();
    const firstBlock = page.blocks[0];
    if (!firstBlock) throw new Error("expected block");
    page.blocks.push({
      ...structuredClone(firstBlock),
      id: SECOND_BLOCK_ID,
      translatedText: "   ",
      bbox: { x: 500, y: 500, w: 180, h: 200 },
    });
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(
      async ({ failureMode }) => ({
        patches:
          failureMode === "required"
            ? [
                {
                  blockId: BLOCK_ID,
                  renderBbox: { x: 100, y: 120, w: 300, h: 260 },
                  renderBboxSpace: "normalized_1000",
                  bubbleLayout: makeBubbleLayout(),
                },
              ]
            : [],
      }),
    );

    const result = await runWorkflow(page, runPage);

    expect(result.status).toBe("completed");
    expect(result.chapter?.pages[0]?.translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "completed",
    });
    expect(result.chapter?.pages[0]?.blocks[1]?.bubbleLayout).toBeUndefined();
  });

  it("completes when every target already has an unchanged usable manual layout", async () => {
    const page = makePendingPage();
    const block = page.blocks[0];
    if (!block) throw new Error("expected block");
    block.bubbleLayout = makeManualBubbleLayout();
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async () => ({
      patches: [],
    }));

    const result = await runWorkflow(page, runPage);

    expect(result.status).toBe("completed");
    expect(result.chapter?.pages[0]?.translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "completed",
    });
    expect(result.chapter?.pages[0]?.blocks[0]?.bubbleLayout).toEqual(
      block.bubbleLayout,
    );
  });
});

async function runWorkflow(
  page: MangaPage,
  runPage: BubbleLayoutRunner["runPage"],
  model: "flux-klein" | "lama-manga" = "flux-klein",
) {
  const chapters = new Map([[CHAPTER_ID, makeChapter(page)]]);
  const runtime = makeRuntime(chapters, runPage, model);
  const { startInpaintingJob } =
    await import("../src/main/jobs/inpaintingJobs");
  return startInpaintingJob(
    makeContext(),
    {
      chapterId: CHAPTER_ID,
      mode: "page-pattern",
      pageId: PAGE_ID,
      postprocess: {
        bubbleLayout: { enabled: true, policy: "balanced" },
      },
    },
    runtime,
  );
}

function makeRuntime(
  chapters: Map<string, ChapterSnapshot>,
  runPage: BubbleLayoutRunner["runPage"],
  model: "flux-klein" | "lama-manga",
): InpaintingJobRuntime {
  const savePages = vi.fn<InpaintingJobRuntime["savePages"]>(
    async (chapterId, pages) => {
      const chapter = chapters.get(chapterId);
      if (!chapter) throw new Error("missing chapter");
      const updates = new Map(
        pages.map((savedPage) => [savedPage.id, savedPage]),
      );
      const saved: ChapterSnapshot = {
        ...chapter,
        pages: chapter.pages.map(
          (storedPage) => updates.get(storedPage.id) ?? storedPage,
        ),
      };
      chapters.set(chapterId, saved);
      return saved;
    },
  );
  return {
    acquireEngine: vi.fn(async () => ({
      engine: {
        model,
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
    inpaintPatternPage: vi.fn(async (targetPage) => ({
      page: {
        ...targetPage,
        inpaintedImagePath: `${targetPage.imagePath}.inpainted.png`,
      },
      blocksErased: 1,
    })),
    logError: vi.fn(),
    openChapter: vi.fn(async (chapterId) => {
      const chapter = chapters.get(chapterId);
      if (!chapter) throw new Error("missing chapter");
      return chapter;
    }),
    savePages,
  };
}

function makeContext(): InpaintingJobContext {
  return {
    appPaths: makeAppPaths(),
    jobs: new ActiveJobStore({ error: vi.fn(), info: vi.fn() }),
    getMainWindow: () => null,
    decodeImage: async () => null,
  };
}

function makePendingPage(): MangaPage {
  return {
    id: PAGE_ID,
    name: "page.png",
    imagePath: "C:\\library\\page.png",
    dataUrl: "data:image/png;base64,AA==",
    width: 1000,
    height: 1000,
    blocks: [
      {
        id: BLOCK_ID,
        type: "nonsolid",
        bbox: { x: 50, y: 60, w: 200, h: 220 },
        sourceText: "source",
        translatedText: "translated",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 16,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#000000",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
    ],
    analysisStatus: "completed",
    translationCompletion: {
      workflow: "bubble-layout",
      status: "pending",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChapter(page: MangaPage): ChapterSnapshot {
  return {
    id: CHAPTER_ID,
    workId: "work-1",
    title: "chapter",
    sourceKind: "images",
    status: "partial",
    pageOrder: [page.id],
    pages: [page],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBubbleLayout(): BubbleLayout {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.96,
    origin: "detected",
    modelId: "fake-runner",
    sourceImageRevision: "fake-source-revision",
    insetRatio: 0.08,
    regions: [
      {
        spans: [
          {
            blockStart: 0.1,
            blockEnd: 0.9,
            inlineStart: 0.08,
            inlineEnd: 0.92,
          },
        ],
      },
    ],
  };
}

function makeManualBubbleLayout(): BubbleLayout {
  return {
    ...makeBubbleLayout(),
    confidence: 1,
    origin: "manual",
    modelId: "manual-shape-v1",
    sourceImageRevision: undefined,
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
    llamaServerPath: "C:\\repo\\llama\\llama-server.exe",
  };
}
