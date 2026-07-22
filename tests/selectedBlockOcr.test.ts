import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterRunPaths } from "../src/main/library";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

const mocks = vi.hoisted(() => ({
  prepareAnalysisRun: vi.fn(),
  prepareKeepBlockHints: vi.fn(),
}));

vi.mock("../src/main/pipeline/prepareAnalysisRun", () => ({
  prepareAnalysisRun: mocks.prepareAnalysisRun,
}));
vi.mock("../src/main/pipeline/keepBlocksOcr", () => ({
  prepareKeepBlockHints: mocks.prepareKeepBlockHints,
}));

import { recognizeSelectedBlock } from "../src/main/jobs/selectedBlockOcr";

describe("selected block OCR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareAnalysisRun.mockResolvedValue({
      runtime: {},
      baseOptions: {
        sourceLanguage: "ja",
        ocrQualityMode: "economy",
        ocrGpuBackend: "cuda",
      },
    });
    mocks.prepareKeepBlockHints.mockResolvedValue(
      new Map([
        [
          "page-1",
          {
            hints: [{ id: 1, ocrText: "右から 左へ" }],
            diagnostics: [],
          },
        ],
      ]),
    );
  });

  it("updates only source text from the PaddleOCR block crop", async () => {
    const page = makePage();
    const result = await recognizeSelectedBlock({
      decodeImage: vi.fn(),
      emit: vi.fn(),
      jobId: "ocr-job",
      page,
      runPaths: {
        chapterDir: "/tmp/chapter",
        runDir: "/tmp/run",
      } as ChapterRunPaths,
      signal: new AbortController().signal,
    });

    expect(mocks.prepareAnalysisRun).toHaveBeenCalledWith(
      expect.objectContaining({ skipOcrPrepass: false }),
    );
    expect(mocks.prepareKeepBlockHints).toHaveBeenCalledWith(
      expect.objectContaining({
        keepPages: [page],
        pageCount: 1,
        baseOptions: expect.objectContaining({ ocrBboxMode: "ocr" }),
      }),
    );
    expect(result.pages[0]?.blocks[0]).toMatchObject({
      sourceText: "右から 左へ",
      translatedText: "기존 번역",
      reviewStatus: "draft",
    });
  });

  it.each([
    ["full", "cuda", "vl"],
    ["economy", "cuda", "ocr"],
    ["minimum", "cuda", "ocr"],
    ["full", "rocm-transformers", "ocr"],
  ] as const)(
    "uses %s quality with %s as %s for selected-block OCR",
    async (ocrQualityMode, ocrGpuBackend, expected) => {
      mocks.prepareAnalysisRun.mockResolvedValue({
        runtime: {},
        baseOptions: {
          sourceLanguage: "ja",
          ocrQualityMode,
          ocrGpuBackend,
        },
      });

      await recognizeSelectedBlock({
        decodeImage: vi.fn(),
        emit: vi.fn(),
        jobId: "ocr-job",
        page: makePage(),
        runPaths: {
          chapterDir: "/tmp/chapter",
          runDir: "/tmp/run",
        } as ChapterRunPaths,
        signal: new AbortController().signal,
      });

      expect(mocks.prepareKeepBlockHints).toHaveBeenCalledWith(
        expect.objectContaining({
          baseOptions: expect.objectContaining({ ocrBboxMode: expected }),
        }),
      );
    },
  );
});

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "/tmp/001.png",
    dataUrl: "",
    width: 1200,
    height: 1600,
    blocks: [makeBlock()],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 300 },
    bboxSpace: "normalized_1000",
    sourceText: "기존 원문",
    translatedText: "기존 번역",
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
  };
}
