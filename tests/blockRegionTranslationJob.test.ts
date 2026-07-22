import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranslationJobContext } from "../src/main/jobs/translationJobTypes";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

const mocks = vi.hoisted(() => ({
  appendAnalyzedPageBlocks: vi.fn(),
  createRegionCropPage: vi.fn(),
  getRunPaths: vi.fn(),
  openChapter: vi.fn(),
  recognizeSelectedBlock: vi.fn(),
  replaceAnalyzedPageBlockText: vi.fn(),
  resolveWorkContextForChapter: vi.fn(),
  runWholePagePipeline: vi.fn(),
}));

vi.mock("../src/main/library", () => ({
  appendAnalyzedPageBlocks: mocks.appendAnalyzedPageBlocks,
  getRunPaths: mocks.getRunPaths,
  openChapter: mocks.openChapter,
  replaceAnalyzedPageBlockText: mocks.replaceAnalyzedPageBlockText,
  resolveWorkContextForChapter: mocks.resolveWorkContextForChapter,
}));
vi.mock("../src/main/regionCrop", () => ({
  createRegionCropPage: mocks.createRegionCropPage,
  mapRegionBlocksToPageBlocks: vi.fn(),
}));
vi.mock("../src/main/wholePagePipeline", () => ({
  runWholePagePipeline: mocks.runWholePagePipeline,
}));
vi.mock("../src/main/jobs/selectedBlockOcr", () => ({
  recognizeSelectedBlock: mocks.recognizeSelectedBlock,
  resolveSelectedBlock: (page: MangaPage, blockId?: string) =>
    page.blocks.find((block) => block.id === blockId),
}));
vi.mock("../src/main/logger", () => ({ logError: vi.fn() }));

import { runRegionTranslationJob } from "../src/main/jobs/translationRegionJobRunner";

describe("selected block OCR and translation job", () => {
  const selectedBlock = makeBlock("selected-block", {
    bbox: { x: 100, y: 150, w: 240, h: 320 },
  });
  const otherBlock = makeBlock("other-block", {
    bbox: { x: 500, y: 600, w: 180, h: 220 },
  });
  const page = makePage([selectedBlock, otherBlock]);
  const chapter = makeChapter(page);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openChapter.mockResolvedValue(chapter);
    mocks.getRunPaths.mockResolvedValue({ runDir: "/tmp/run" });
    mocks.resolveWorkContextForChapter.mockResolvedValue({});
    mocks.runWholePagePipeline.mockResolvedValue({
      pages: [
        {
          ...page,
          blocks: [
            {
              ...selectedBlock,
              sourceText: "新しい原文",
              translatedText: "새 번역",
              confidence: 0.8,
            },
          ],
        },
      ],
      warnings: [],
    });
    mocks.recognizeSelectedBlock.mockResolvedValue({
      pages: [
        {
          ...page,
          blocks: [{ ...selectedBlock, sourceText: "OCR로 갱신된 원문" }],
        },
      ],
      warnings: [],
    });
    mocks.replaceAnalyzedPageBlockText.mockResolvedValue(chapter);
  });

  it("translates from the current OCR text without running PaddleOCR again", async () => {
    const result = await runRegionTranslationJob({
      context: {
        decodeImage: vi.fn(),
        getMainWindow: () => null,
        jobs: { setCleanup: vi.fn() },
      } as unknown as TranslationJobContext,
      request: {
        chapterId: chapter.id,
        pageId: page.id,
        bbox: selectedBlock.bbox,
        targetBlockId: selectedBlock.id,
        targetBlockOperation: "translate",
      },
      id: "block-job",
      abortController: new AbortController(),
      emit: vi.fn(),
      state: { chapter: null, runPaths: null },
    });

    expect(mocks.createRegionCropPage).not.toHaveBeenCalled();
    expect(mocks.runWholePagePipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        blockMode: "keep",
        pages: [expect.objectContaining({ blocks: [selectedBlock] })],
        regionContext: undefined,
        selectedBlockTranslationSourceText: selectedBlock.sourceText,
        skipOcrPrepass: true,
        writeStoryMemory: false,
      }),
    );
    expect(mocks.replaceAnalyzedPageBlockText).toHaveBeenCalledWith(
      chapter.id,
      page.id,
      selectedBlock.id,
      expect.objectContaining({
        sourceText: "新しい原文",
        translatedText: "새 번역",
      }),
      "translate",
    );
    expect(mocks.appendAnalyzedPageBlocks).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "completed",
      blockIds: [selectedBlock.id],
      replacedBlockId: selectedBlock.id,
      targetBlockOperation: "translate",
    });
  });

  it("runs PaddleOCR only and saves the recognized source text", async () => {
    const result = await runRegionTranslationJob({
      context: {
        decodeImage: vi.fn(),
        getMainWindow: () => null,
        jobs: { setCleanup: vi.fn() },
      } as unknown as TranslationJobContext,
      request: {
        chapterId: chapter.id,
        pageId: page.id,
        bbox: selectedBlock.bbox,
        targetBlockId: selectedBlock.id,
        targetBlockOperation: "ocr",
      },
      id: "ocr-block-job",
      abortController: new AbortController(),
      emit: vi.fn(),
      state: { chapter: null, runPaths: null },
    });

    expect(mocks.runWholePagePipeline).not.toHaveBeenCalled();
    expect(mocks.recognizeSelectedBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "ocr-block-job",
        page: expect.objectContaining({ blocks: [selectedBlock] }),
      }),
    );
    expect(mocks.replaceAnalyzedPageBlockText).toHaveBeenCalledWith(
      chapter.id,
      page.id,
      selectedBlock.id,
      expect.objectContaining({ sourceText: "OCR로 갱신된 원문" }),
      "ocr",
    );
    expect(result).toMatchObject({
      status: "completed",
      replacedBlockId: selectedBlock.id,
      targetBlockOperation: "ocr",
    });
  });
});

function makeBlock(
  id: string,
  patch: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    bboxSpace: "normalized_1000",
    sourceText: "原文",
    translatedText: "번역",
    confidence: 0.9,
    sourceDirection: "vertical",
    renderDirection: "vertical",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    autoFitText: true,
    ...patch,
  };
}

function makePage(blocks: TranslationBlock[]): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "/tmp/001.png",
    dataUrl: "",
    width: 1200,
    height: 1600,
    blocks,
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChapter(page: MangaPage): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "folder",
    status: "completed",
    pageOrder: [page.id],
    pages: [page],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
