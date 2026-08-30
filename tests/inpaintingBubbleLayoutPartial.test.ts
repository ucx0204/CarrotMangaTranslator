import { describe, expect, it, vi } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import type { AppPaths } from "../src/main/appPaths";
import {
  runBubbleLayoutPostprocess,
  type BubbleLayoutRunner,
} from "../src/main/inpainting/bubbleLayoutRunner";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { InpaintingJobContext } from "../src/main/jobs/inpaintingJobTypes";
import {
  productionInpaintingJobRuntime,
  type InpaintingJobRuntime,
} from "../src/main/jobs/inpaintingJobRuntime";
import type { BubbleLayout } from "../src/shared/bubbleLayout";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";

const CHAPTER_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const BLOCK_ID = "block-1";
const SECOND_BLOCK_ID = "block-2";
const TRANSACTION_ID = "33333333-3333-4333-8333-333333333333";

describe("partial bubble-aware inpainting postprocess", () => {
  it("does not lay translated text over incomplete blocks", async () => {
    const originalPage = makeTwoBlockPage();
    originalPage.translationCompletion = {
      workflow: "bubble-layout",
      status: "pending",
    };
    const chapters = new Map([[CHAPTER_ID, makeChapter(originalPage)]]);
    const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async () => ({
      patches: makeLayoutPatches(),
    }));
    const runtime = makeRuntime(
      chapters,
      vi.fn(() => ({ runPage })),
    );
    runtime.inpaintPatternPage = vi.fn(async (page) => ({
      page: {
        ...page,
        inpaintedImagePath: `${page.imagePath}.inpainted.png`,
      },
      blocksErased: 1,
      blocksIncomplete: 1,
      erasedBlockIds: [BLOCK_ID],
      incompleteBlockIds: [SECOND_BLOCK_ID],
    }));
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");

    const result = await startInpaintingJob(
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

    expect(result.status).toBe("partial");
    expect(result.chapter?.pages[0]?.blocks[0]?.bubbleLayout).toEqual(
      makeBubbleLayout(),
    );
    expect(result.chapter?.pages[0]?.blocks[1]?.bubbleLayout).toBeUndefined();
    expect(result.chapter?.pages[0]?.translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "pending",
      erasedBlockIds: [BLOCK_ID],
    });
  });

  it("applies final Bubble changes only to blocks erased by a partial run", async () => {
    const processed = await runBubbleLayoutPostprocess({
      blockIds: [BLOCK_ID],
      config: { policy: "balanced", overwriteManual: false },
      page: makeTwoBlockPage(),
      runner: { runPage: async () => ({ patches: makeLayoutPatches() }) },
      signal: new AbortController().signal,
    });

    expect(processed.afterLayout?.map((state) => state.blockId)).toEqual([
      BLOCK_ID,
    ]);
    expect(processed.page.blocks[0]?.bubbleLayout).toEqual(makeBubbleLayout());
    expect(processed.page.blocks[1]?.bubbleLayout).toBeUndefined();
  });
});

function makeLayoutPatches() {
  return [BLOCK_ID, SECOND_BLOCK_ID].map((blockId) => ({
    blockId,
    renderBbox: { x: 100, y: 120, w: 240, h: 140 },
    renderBboxSpace: "normalized_1000" as const,
    bubbleLayout: makeBubbleLayout(),
  }));
}

function makeRuntime(
  chapters: Map<string, ChapterSnapshot>,
  createBubbleLayoutRunner: NonNullable<
    InpaintingJobRuntime["createBubbleLayoutRunner"]
  >,
): InpaintingJobRuntime {
  const settings = resolveDefaultAppSettings();
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
    emitEvent: (jobs, _window, event) => jobs.updateLastEvent(event.id, event),
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
    openPageTimingSession: productionInpaintingJobRuntime.openPageTimingSession,
    openChapter: vi.fn(async (chapterId) => {
      const chapter = chapters.get(chapterId);
      if (!chapter) throw new Error("missing chapter");
      return chapter;
    }),
    savePages: vi.fn<InpaintingJobRuntime["savePages"]>(
      async (chapterId, pages) => {
        const current = chapters.get(chapterId);
        if (!current) throw new Error("missing chapter");
        const updates = new Map(pages.map((page) => [page.id, page]));
        const saved = {
          ...current,
          pages: current.pages.map((page) => updates.get(page.id) ?? page),
        };
        chapters.set(chapterId, saved);
        return saved;
      },
    ),
  };
}

function makeContext(): InpaintingJobContext {
  return {
    appPaths: makeAppPaths(),
    jobs: new ActiveJobStore({ error: vi.fn(), info: vi.fn() }),
    getMainWindow: () => null,
    decodeImage: async () => null,
    inpaintingRevisionStore: {
      beginTransaction: () => TRANSACTION_ID,
      addChange: () => true,
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

function makeTwoBlockPage(): MangaPage {
  const page = makePage();
  const firstBlock = page.blocks[0];
  if (!firstBlock) throw new Error("expected first block");
  page.blocks.push({
    ...structuredClone(firstBlock),
    id: SECOND_BLOCK_ID,
    bbox: { x: 500, y: 500, w: 200, h: 220 },
  });
  return page;
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
