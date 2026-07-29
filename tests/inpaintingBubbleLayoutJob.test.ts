import { describe, expect, it, vi } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import type { AppPaths } from "../src/main/appPaths";
import {
  runBubbleLayoutPostprocess,
  type BubbleLayoutRunner,
} from "../src/main/inpainting/bubbleLayoutRunner";
import type { InpaintingRevisionChange } from "../src/main/inpainting/inpaintingRevisionStore";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { InpaintingJobContext } from "../src/main/jobs/inpaintingJobTypes";
import type { InpaintingJobRuntime } from "../src/main/jobs/inpaintingJobRuntime";
import type { BubbleLayout } from "../src/shared/bubbleLayout";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";

const CHAPTER_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const BLOCK_ID = "block-1";
const SECOND_BLOCK_ID = "block-2";
const TRANSACTION_ID = "33333333-3333-4333-8333-333333333333";

describe("bubble-aware inpainting postprocess", () => {
  it("applies only the render allowlist and records one compound revision", async () => {
    const originalPage = makePage();
    const chapters = new Map([[CHAPTER_ID, makeChapter(originalPage)]]);
    const changes: InpaintingRevisionChange[] = [];
    const layout = makeBubbleLayout();
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async ({ page }) => {
      // Adapter-side mutation cannot escape because the port receives a clone.
      const adapterBlock = page.blocks[0];
      if (!adapterBlock) {
        throw new Error("expected adapter block");
      }
      adapterBlock.bbox = { x: 999, y: 999, w: 1, h: 1 };
      return {
        patches: [
          {
            blockId: BLOCK_ID,
            renderBbox: { x: 100, y: 120, w: 300, h: 260 },
            renderBboxSpace: "normalized_1000",
            bubbleLayout: layout,
            // Runtime-shaped malicious data is deliberately outside the type.
            bbox: { x: 900, y: 900, w: 10, h: 10 },
            renderDirection: "vertical",
            sourceDirection: "vertical",
          } as never,
        ],
      };
    });
    const createBubbleLayoutRunner = vi.fn(() => ({ runPage }));
    const runtime = makeRuntime(chapters, createBubbleLayoutRunner);
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(changes),
      {
        chapterId: CHAPTER_ID,
        mode: "page-pattern",
        pageId: PAGE_ID,
        postprocess: {
          bubbleLayout: { enabled: true, policy: "safe" },
        },
      },
      runtime,
    );

    expect(result.status).toBe("completed");
    expect(createBubbleLayoutRunner).toHaveBeenCalledTimes(1);
    expect(runPage).toHaveBeenCalledWith(
      expect.objectContaining({
        imagePath: `${originalPage.imagePath}.inpainted.png`,
        policy: "safe",
      }),
    );
    const savedBlock = result.chapter?.pages[0]?.blocks[0];
    expect(savedBlock?.bbox).toEqual(originalPage.blocks[0]?.bbox);
    expect(savedBlock?.renderDirection).toBe(
      originalPage.blocks[0]?.renderDirection,
    );
    expect(savedBlock?.sourceDirection).toBe(
      originalPage.blocks[0]?.sourceDirection,
    );
    expect(savedBlock?.renderBbox).toEqual({
      x: 100,
      y: 120,
      w: 300,
      h: 260,
    });
    expect(savedBlock?.bubbleLayout).toEqual(layout);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      chapterId: CHAPTER_ID,
      pageId: PAGE_ID,
      beforePath: undefined,
      afterPath: `${originalPage.imagePath}.inpainted.png`,
      beforeLayout: [
        {
          blockId: BLOCK_ID,
          renderBbox: null,
          renderBboxSpace: null,
          bubbleLayout: null,
        },
      ],
      afterLayout: [
        {
          blockId: BLOCK_ID,
          renderBbox: { x: 100, y: 120, w: 300, h: 260 },
          renderBboxSpace: "normalized_1000",
          bubbleLayout: layout,
        },
      ],
    });
    expect(runtime.savePages).toHaveBeenCalledWith(
      CHAPTER_ID,
      expect.any(Array),
      expect.objectContaining({
        layoutPatches: [
          expect.objectContaining({
            pageId: PAGE_ID,
            states: changes[0]?.afterLayout,
          }),
        ],
      }),
    );
  });

  it("keeps the safe default off and does not construct the runner", async () => {
    const page = makePage();
    const chapters = new Map([[CHAPTER_ID, makeChapter(page)]]);
    const createBubbleLayoutRunner = vi.fn(() => ({
      runPage: vi.fn(),
    }));
    const runtime = makeRuntime(chapters, createBubbleLayoutRunner);
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext([]),
      {
        chapterId: CHAPTER_ID,
        mode: "page-pattern",
        pageId: PAGE_ID,
      },
      runtime,
    );

    expect(result.status).toBe("completed");
    expect(createBubbleLayoutRunner).not.toHaveBeenCalled();
  });

  it("runs layout-only mode without rerunning the inpainting engine", async () => {
    const page = {
      ...makePage(),
      inpaintedImagePath: "C:\\library\\page.inpainted.png",
    };
    const chapters = new Map([[CHAPTER_ID, makeChapter(page)]]);
    const changes: InpaintingRevisionChange[] = [];
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async () => ({
      patches: [
        {
          blockId: BLOCK_ID,
          renderBbox: { x: 140, y: 160, w: 280, h: 240 },
          renderBboxSpace: "normalized_1000",
          bubbleLayout: makeBubbleLayout(),
        },
      ],
    }));
    const runtime = makeRuntime(chapters, () => ({ runPage }));
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(changes),
      {
        chapterId: CHAPTER_ID,
        mode: "page-bubble-layout",
        pageId: PAGE_ID,
        policy: "maximize",
      },
      runtime,
    );

    expect(result.status).toBe("completed");
    expect(runtime.acquireEngine).not.toHaveBeenCalled();
    expect(runtime.inpaintPatternPage).not.toHaveBeenCalled();
    expect(runPage).toHaveBeenCalledWith(
      expect.objectContaining({
        imagePath: page.inpaintedImagePath,
        policy: "maximize",
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.beforePath).toBe(page.inpaintedImagePath);
    expect(changes[0]?.afterPath).toBe(page.inpaintedImagePath);
    expect(changes[0]?.beforeLayout?.[0]?.bubbleLayout).toBeNull();
    expect(changes[0]?.afterLayout?.[0]?.bubbleLayout).toEqual(
      makeBubbleLayout(),
    );
  });

  it("runs layout-only mode from the original image before inpainting", async () => {
    const page = makePage();
    const chapters = new Map([[CHAPTER_ID, makeChapter(page)]]);
    const changes: InpaintingRevisionChange[] = [];
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async () => ({
      patches: [
        {
          blockId: BLOCK_ID,
          renderBbox: { x: 140, y: 160, w: 280, h: 240 },
          renderBboxSpace: "normalized_1000",
          bubbleLayout: makeBubbleLayout(),
        },
      ],
    }));
    const runtime = makeRuntime(chapters, () => ({ runPage }));
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(changes),
      {
        chapterId: CHAPTER_ID,
        mode: "page-bubble-layout",
        pageId: PAGE_ID,
        policy: "balanced",
      },
      runtime,
    );

    expect(result.status).toBe("completed");
    expect(runtime.acquireEngine).not.toHaveBeenCalled();
    expect(runtime.inpaintPatternPage).not.toHaveBeenCalled();
    expect(runPage).toHaveBeenCalledWith(
      expect.objectContaining({
        imagePath: page.imagePath,
        policy: "balanced",
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.beforePath).toBeUndefined();
    expect(changes[0]?.afterPath).toBeUndefined();
    expect(changes[0]?.beforeLayout?.[0]?.bubbleLayout).toBeNull();
    expect(changes[0]?.afterLayout?.[0]?.bubbleLayout).toEqual(
      makeBubbleLayout(),
    );
  });

  it("detects the full page but applies layout only to the requested block", async () => {
    const page = makePage();
    const firstBlock = page.blocks[0];
    if (!firstBlock) {
      throw new Error("expected first block");
    }
    page.blocks.push({
      ...structuredClone(firstBlock),
      id: SECOND_BLOCK_ID,
      bbox: { x: 600, y: 620, w: 180, h: 200 },
    });
    const chapters = new Map([[CHAPTER_ID, makeChapter(page)]]);
    const changes: InpaintingRevisionChange[] = [];
    const firstLayout = makeBubbleLayout();
    const secondLayout = {
      ...makeBubbleLayout(),
      sourceImageRevision: "second-source-revision",
    };
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async ({ page }) => ({
      patches: page.blocks.map((block) => ({
        blockId: block.id,
        renderBbox:
          block.id === BLOCK_ID
            ? { x: 100, y: 120, w: 300, h: 260 }
            : { x: 580, y: 600, w: 220, h: 240 },
        renderBboxSpace: "normalized_1000",
        bubbleLayout: block.id === BLOCK_ID ? firstLayout : secondLayout,
      })),
    }));
    const runtime = makeRuntime(chapters, () => ({ runPage }));
    const emitEvent = vi.fn<InpaintingJobRuntime["emitEvent"]>(
      (jobs, _window, event) => {
        jobs.updateLastEvent(event.id, event);
      },
    );
    runtime.emitEvent = emitEvent;
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(changes),
      {
        chapterId: CHAPTER_ID,
        mode: "page-bubble-layout",
        pageId: PAGE_ID,
        blockId: BLOCK_ID,
        policy: "balanced",
      },
      runtime,
    );

    expect(result.status).toBe("completed");
    expect(
      runPage.mock.calls[0]?.[0].page.blocks.map((block) => block.id),
    ).toEqual([BLOCK_ID, SECOND_BLOCK_ID]);
    expect(result.chapter?.pages[0]?.blocks[0]?.bubbleLayout).toEqual(
      firstLayout,
    );
    expect(result.chapter?.pages[0]?.blocks[1]?.bubbleLayout).toBeUndefined();
    expect(changes[0]?.beforeLayout).toHaveLength(1);
    expect(changes[0]?.beforeLayout?.[0]?.blockId).toBe(BLOCK_ID);
    expect(changes[0]?.afterLayout).toHaveLength(1);
    const startingEvent = emitEvent.mock.calls
      .map(([, , event]) => event)
      .find((event) => event.status === "starting");
    expect(startingEvent?.detail).toBe("1페이지, 1개 블록");
  });

  it.each(["page-pattern", "page-bubble-layout"] as const)(
    "rejects an unknown requested block before starting %s work",
    async (mode) => {
      const page = makePage();
      const chapters = new Map([[CHAPTER_ID, makeChapter(page)]]);
      const changes: InpaintingRevisionChange[] = [];
      const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async () => ({
        patches: [],
      }));
      const createBubbleLayoutRunner = vi.fn(() => ({ runPage }));
      const runtime = makeRuntime(chapters, createBubbleLayoutRunner);
      const { startInpaintingJob } =
        await import("../src/main/jobs/inpaintingJobs");

      const result = await startInpaintingJob(
        makeContext(changes),
        mode === "page-pattern"
          ? {
              chapterId: CHAPTER_ID,
              mode,
              pageId: PAGE_ID,
              blockId: "missing-block",
            }
          : {
              chapterId: CHAPTER_ID,
              mode,
              pageId: PAGE_ID,
              blockId: "missing-block",
              policy: "balanced",
            },
        runtime,
      );

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/텍스트 블록.*찾지 못했습니다/);
      expect(runtime.acquireEngine).not.toHaveBeenCalled();
      expect(runtime.inpaintPatternPage).not.toHaveBeenCalled();
      expect(createBubbleLayoutRunner).not.toHaveBeenCalled();
      expect(runPage).not.toHaveBeenCalled();
      expect(runtime.savePages).not.toHaveBeenCalled();
      expect(changes).toHaveLength(0);
    },
  );

  it("keeps a manual layout during automatic postprocess after inpainting", async () => {
    const page = makePage();
    const block = page.blocks[0];
    if (!block) {
      throw new Error("expected block");
    }
    const manualLayout = makeManualBubbleLayout();
    block.renderBbox = { x: 90, y: 110, w: 320, h: 300 };
    block.renderBboxSpace = "normalized_1000";
    block.bubbleLayout = manualLayout;
    const chapters = new Map([[CHAPTER_ID, makeChapter(page)]]);
    const changes: InpaintingRevisionChange[] = [];
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async () => ({
      patches: [
        {
          blockId: BLOCK_ID,
          renderBbox: { x: 140, y: 160, w: 280, h: 240 },
          renderBboxSpace: "normalized_1000",
          bubbleLayout: makeBubbleLayout(),
        },
      ],
    }));
    const runtime = makeRuntime(chapters, () => ({ runPage }));
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(changes),
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

    expect(result.status).toBe("completed");
    expect(runPage).toHaveBeenCalledTimes(1);
    const savedBlock = result.chapter?.pages[0]?.blocks[0];
    expect(savedBlock?.renderBbox).toEqual(block.renderBbox);
    expect(savedBlock?.bubbleLayout).toEqual(manualLayout);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.beforeLayout).toBeUndefined();
    expect(changes[0]?.afterLayout).toBeUndefined();
  });

  it("lets the explicit layout-only command replace a manual layout", async () => {
    const page = makePage();
    const block = page.blocks[0];
    if (!block) {
      throw new Error("expected block");
    }
    block.renderBbox = { x: 90, y: 110, w: 320, h: 300 };
    block.renderBboxSpace = "normalized_1000";
    block.bubbleLayout = makeManualBubbleLayout();
    const chapters = new Map([[CHAPTER_ID, makeChapter(page)]]);
    const changes: InpaintingRevisionChange[] = [];
    const detectedLayout = makeBubbleLayout();
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async () => ({
      patches: [
        {
          blockId: BLOCK_ID,
          renderBbox: { x: 140, y: 160, w: 280, h: 240 },
          renderBboxSpace: "normalized_1000",
          bubbleLayout: detectedLayout,
        },
      ],
    }));
    const runtime = makeRuntime(chapters, () => ({ runPage }));
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
      makeContext(changes),
      {
        chapterId: CHAPTER_ID,
        mode: "page-bubble-layout",
        pageId: PAGE_ID,
        policy: "balanced",
      },
      runtime,
    );

    expect(result.status).toBe("completed");
    expect(result.chapter?.pages[0]?.blocks[0]?.bubbleLayout).toEqual(
      detectedLayout,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.beforeLayout?.[0]?.bubbleLayout).toEqual(
      makeManualBubbleLayout(),
    );
    expect(changes[0]?.afterLayout?.[0]?.bubbleLayout).toEqual(detectedLayout);
  });

  it("rejects an unknown block before any page commit", async () => {
    const page = makePage();
    const runner: BubbleLayoutRunner = {
      runPage: async () => ({
        patches: [
          {
            blockId: "unknown",
            bubbleLayout: makeBubbleLayout(),
          },
        ],
      }),
    };

    await expect(
      runBubbleLayoutPostprocess({
        config: { policy: "balanced", overwriteManual: false },
        page: {
          ...page,
          inpaintedImagePath: `${page.imagePath}.inpainted.png`,
        },
        runner,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/알 수 없는 블록/);
  });

  it("allows clearing stale layout only when one already exists", async () => {
    const stalePage = makePage();
    const staleBlock = stalePage.blocks[0];
    if (!staleBlock) {
      throw new Error("expected stale block");
    }
    staleBlock.bubbleLayout = makeBubbleLayout();
    const clearRunner: BubbleLayoutRunner = {
      runPage: async () => ({
        patches: [{ blockId: BLOCK_ID, bubbleLayout: null }],
      }),
    };

    const cleared = await runBubbleLayoutPostprocess({
      config: { policy: "maximize", overwriteManual: false },
      page: {
        ...stalePage,
        inpaintedImagePath: `${stalePage.imagePath}.inpainted.png`,
      },
      runner: clearRunner,
      signal: new AbortController().signal,
    });
    expect(cleared.page.blocks[0]?.bubbleLayout).toBeUndefined();
    expect(cleared.beforeLayout?.[0]?.bubbleLayout).toEqual(makeBubbleLayout());
    expect(cleared.afterLayout?.[0]?.bubbleLayout).toBeNull();

    await expect(
      runBubbleLayoutPostprocess({
        config: { policy: "maximize", overwriteManual: false },
        page: {
          ...makePage(),
          inpaintedImagePath: `${stalePage.imagePath}.inpainted.png`,
        },
        runner: clearRunner,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/기존 말풍선 배치가 없는/);
  });
});

function makeRuntime(
  chapters: Map<string, ChapterSnapshot>,
  createBubbleLayoutRunner: NonNullable<
    InpaintingJobRuntime["createBubbleLayoutRunner"]
  >,
): InpaintingJobRuntime {
  const settings = resolveDefaultAppSettings();
  const savePages = vi.fn<InpaintingJobRuntime["savePages"]>(
    async (chapterId, pages) => {
      const current = chapters.get(chapterId);
      if (!current) {
        throw new Error("missing chapter");
      }
      const updates = new Map(pages.map((page) => [page.id, page]));
      const saved = {
        ...current,
        pages: current.pages.map((page) => updates.get(page.id) ?? page),
      };
      chapters.set(chapterId, saved);
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
    createBubbleLayoutRunner,
    emitEvent: (jobs, _window, event) => {
      jobs.updateLastEvent(event.id, event);
    },
    getSettings: vi.fn(async () => settings),
    inpaintDrawnPage: vi.fn(async () => {
      throw new Error("unexpected drawn inpainting");
    }),
    inpaintPatternPage: vi.fn(async (page) => ({
      page: {
        ...page,
        inpaintedImagePath: `${page.imagePath}.inpainted.png`,
      },
      blocksErased: 1,
    })),
    logError: vi.fn(),
    openChapter: vi.fn(async (chapterId) => {
      const chapter = chapters.get(chapterId);
      if (!chapter) {
        throw new Error("missing chapter");
      }
      return chapter;
    }),
    savePages,
  };
}

function makeContext(
  changes: InpaintingRevisionChange[],
): InpaintingJobContext {
  return {
    appPaths: makeAppPaths(),
    jobs: new ActiveJobStore({ error: vi.fn(), info: vi.fn() }),
    getMainWindow: () => null,
    decodeImage: async () => null,
    inpaintingRevisionStore: {
      beginTransaction: () => TRANSACTION_ID,
      addChange: (_transactionId, change) => {
        changes.push(structuredClone(change));
        return true;
      },
      removeChange: async () => undefined,
      discardIfEmpty: () => undefined,
      getReference: () => ({ transactionId: TRANSACTION_ID }),
      getRetainedArtifactPaths: () => [],
    },
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

function makePage(): MangaPage {
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
        translatedText: "translated text",
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
    status: "completed",
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
    version: 1,
    direction: "horizontal",
    confidence: 1,
    origin: "manual",
    modelId: "manual-shape-v1",
    insetRatio: 0.05,
    regions: [
      {
        spans: [
          {
            blockStart: 0.05,
            blockEnd: 0.95,
            inlineStart: 0.1,
            inlineEnd: 0.9,
          },
        ],
      },
    ],
  };
}
