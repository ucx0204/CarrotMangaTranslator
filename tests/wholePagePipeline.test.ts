import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../src/shared/workContextTypes";
import type { JobEvent } from "../src/shared/jobTypes";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { AppSettings } from "../src/shared/settingsTypes";
import type { TranslationOptions } from "../src/main/appSettings";
import type { AppPaths } from "../src/main/appPaths";
import type {
  OcrBboxResult,
  PipelineOptions,
  PipelineWorkContext,
} from "../src/main/pipeline/types";
import type { TranslationRuntimePort } from "../src/main/pipeline/translationRuntimePort";
import type { WholePagePipelineDependencies } from "../src/main/pipeline/wholePagePipelinePorts";
import { runWholePagePipeline as runWholePagePipelineWithDependencies } from "../src/main/wholePagePipeline";

const tempDirs: string[] = [];
let runSequence = 0;
const require = createRequire(import.meta.url);
const overlayParser = require(
  join(process.cwd(), "src", "main", "runtime", "overlay-parser.cjs"),
) as Pick<
  TranslationRuntimePort,
  | "normalizeItems"
  | "normalizeRegionSingleItem"
  | "parseJsonLenient"
  | "parseRegionSingleItem"
>;

afterEach(async () => {
  vi.clearAllMocks();
  delete process.env.MANGA_TRANSLATOR_PAGE_RETRIES;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("whole page pipeline", () => {
  it("retries transient page failures and completes the page", async () => {
    process.env.MANGA_TRANSLATOR_PAGE_RETRIES = "2";
    const requestTranslation = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary transport failure"))
      .mockResolvedValueOnce(successTranslationResult());
    const { runWholePagePipeline, runtime } = await loadPipeline({
      requestTranslation,
    });
    const events: JobEvent[] = [];

    const result = await runWholePagePipeline({
      ...basePipelineOptions([makePage("page-a", "001.png")], events),
    });

    expect(requestTranslation).toHaveBeenCalledTimes(2);
    expect(requestTranslation.mock.calls[1]?.[1]).toMatchObject({
      imagePath: "C:\\images\\001.png",
      label: "page-1-attempt-2",
      pageId: "page-a",
      pageIndex: 0,
    });
    expect(runtime.saveArtifacts).toHaveBeenCalledOnce();
    expect(runtime.disposeEndpoint).toHaveBeenCalledTimes(1);
    expect(runtime.warn).toHaveBeenCalledWith(
      "Analysis attempt failed",
      expect.objectContaining({
        attempt: 1,
        attemptTotal: 2,
        willRetry: true,
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(events.map((event) => event.phase)).toContain("page_retry");
    expect(result.pages[0]?.analysisStatus).toBe("completed");
    expect(result.pages[0]?.blocks).toHaveLength(1);
    expect(result.warnings).toEqual([
      "001.png: 시도 1/2 실패 - temporary transport failure",
    ]);
  });

  it("propagates abort errors without marking a page as failed", async () => {
    process.env.MANGA_TRANSLATOR_PAGE_RETRIES = "2";
    const requestTranslation = vi
      .fn()
      .mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const { runWholePagePipeline, runtime } = await loadPipeline({
      requestTranslation,
    });
    const onPageFailed = vi.fn();
    const workContext: PipelineWorkContext = {
      workId: "work-a",
      chapterId: "chapter-a",
      styleGuide: makeStyleGuide(),
      storyMemory: { ...makeStoryMemory(), pages: [] },
      recentPageCount: 6,
    };

    await expect(
      runWholePagePipeline({
        ...basePipelineOptions([makePage("page-a", "001.png")], []),
        onPageFailed,
        collectPageContext: true,
        workContext,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(requestTranslation).toHaveBeenCalledTimes(1);
    expect(onPageFailed).not.toHaveBeenCalled();
    expect(workContext.storyMemory.pages).toEqual([]);
    expect(workContext.styleGuide.glossary).toHaveLength(1);
    expect(runtime.disposeEndpoint).toHaveBeenCalledTimes(1);
  });

  it("propagates non-retriable API failures without skipping the page", async () => {
    process.env.MANGA_TRANSLATOR_PAGE_RETRIES = "5";
    const apiError = Object.assign(
      new Error(
        "API 오류 401 Unauthorized: 인증에 실패했습니다. API 키가 잘못됐거나 만료됐을 수 있습니다. 키가 맞다면 선택한 모델이 이미지 입력을 지원하는지 확인하세요. 자세한 내용은 로그를 확인하세요.",
      ),
      { failureCategory: "model-request", nonRetriable: true },
    );
    const requestTranslation = vi.fn().mockRejectedValue(apiError);
    const onPageFailed = vi.fn();
    const events: JobEvent[] = [];
    const { runWholePagePipeline, runtime } = await loadPipeline({
      requestTranslation,
    });

    await expect(
      runWholePagePipeline({
        ...basePipelineOptions([makePage("page-a", "001.png")], events),
        onPageFailed,
      }),
    ).rejects.toBe(apiError);

    expect(requestTranslation).toHaveBeenCalledTimes(1);
    expect(onPageFailed).not.toHaveBeenCalled();
    expect(events.map((event) => event.phase)).not.toContain("page_skipped");
    expect(runtime.disposeEndpoint).toHaveBeenCalledTimes(1);
  });

  it("skips model calls when OCR prepass reports no text", async () => {
    const page = makePage("page-a", "001.png");
    const requestTranslation = vi.fn();
    const startEndpointSession = vi.fn();
    const onPagesComplete = vi.fn();
    const events: JobEvent[] = [];
    const { runWholePagePipeline, runtime } = await loadPipeline({
      ocrHintsByImagePath: new Map([
        [
          page.imagePath,
          {
            hints: [],
            diagnostics: [],
            noTextDetected: true,
            textEvidenceCount: 0,
          },
        ],
      ]),
      requestTranslation,
      startEndpointSession,
    });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([page], events),
      onPagesComplete,
    });

    expect(startEndpointSession).not.toHaveBeenCalled();
    expect(requestTranslation).not.toHaveBeenCalled();
    expect(runtime.collectOcrHintsBatch).toHaveBeenCalledOnce();
    expect(runtime.collectOcrHintsBatch.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        imagePath: page.imagePath,
        label: "ocr-page-1",
        ocrPageIndex: 1,
        ocrPageTotal: 1,
      }),
    ]);
    expect(onPagesComplete).toHaveBeenCalledWith([
      expect.objectContaining({ id: page.id, blocks: [] }),
    ]);
    expect(result.pages[0]).toMatchObject({
      id: page.id,
      analysisStatus: "completed",
      blocks: [],
    });
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining(["ocr_preparing", "page_done", "finalizing"]),
    );
  });

  it("still calls the model for non-Japanese pages when OCR reports no text", async () => {
    const page = makePage("page-a", "001.png");
    const requestTranslation = vi.fn().mockResolvedValue({
      ...successTranslationResult(),
      requestBody: { noTextDetected: true },
    });
    const startEndpointSession = vi.fn(async () => ({
      handle: {
        baseUrl: "http://127.0.0.1:39281",
        child: null,
        startedByScript: false,
      },
      dispose: vi.fn(async () => undefined),
    }));
    const { runWholePagePipeline } = await loadPipeline({
      sourceLanguage: "en-US",
      ocrHintsByImagePath: new Map([
        [
          page.imagePath,
          {
            hints: [],
            diagnostics: [],
            noTextDetected: true,
            textEvidenceCount: 0,
          },
        ],
      ]),
      requestTranslation,
      startEndpointSession,
    });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([page], []),
      collectPageContext: true,
    });

    expect(startEndpointSession).toHaveBeenCalledTimes(1);
    expect(requestTranslation).toHaveBeenCalledTimes(1);
    expect(result.pages[0]?.blocks).toHaveLength(1);
  });

  it("feeds a successful page context into the next canonical chapter page", async () => {
    const firstPage = makePage("page-a", "005.png");
    const secondPage = makePage("page-b", "008.png");
    const workContext = {
      workId: "work-a",
      chapterId: "chapter-a",
      styleGuide: { ...makeStyleGuide(), glossary: [] },
      storyMemory: { ...makeStoryMemory(), pages: [] },
      recentPageCount: 6,
    };
    const requestTranslation = vi.fn(
      async (_server: unknown, options: TranslationOptions) => {
        if (options.pageId === secondPage.id) {
          expect(options.pageIndex).toBe(7);
          expect(options.label).toBe("page-8-attempt-1");
          expect(options.workContext?.styleGuide.glossary).toEqual([
            expect.objectContaining({
              source: "勇者",
              target: "용사",
              origin: "ai",
            }),
          ]);
          expect(options.workContext?.storyMemory.pages).toEqual([
            expect.objectContaining({
              pageId: firstPage.id,
              pageIndex: 4,
              visualSummary: "용사가 성문 앞에서 동료를 부른다.",
            }),
          ]);
          return translationWithPageContext("次へ", "다음으로", {
            visualSummary: "일행이 다음 장소로 이동한다.",
            glossary: [],
            characters: [],
          });
        }
        expect(options.pageIndex).toBe(4);
        expect(options.label).toBe("page-5-attempt-1");
        return translationWithPageContext("勇者", "용사", {
          visualSummary: "용사가 성문 앞에서 동료를 부른다.",
          glossary: [
            {
              source: "勇者",
              target: "용사",
              category: "term",
              aliases: [],
            },
          ],
          characters: [],
        });
      },
    );
    const events: JobEvent[] = [];
    const { runWholePagePipeline, runtime } = await loadPipeline({
      requestTranslation,
    });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([firstPage, secondPage], events),
      workContext,
      collectPageContext: true,
      canonicalPageIndexById: new Map([
        [firstPage.id, 4],
        [secondPage.id, 7],
      ]),
    });

    expect(
      result.pages.every((page) => page.analysisStatus === "completed"),
    ).toBe(true);
    expect(requestTranslation).toHaveBeenCalledTimes(2);
    expect(runtime.saveWorkStyleGuide).toHaveBeenCalledTimes(1);
    expect(runtime.saveChapterStoryMemory).toHaveBeenCalledTimes(2);
    expect(
      events
        .filter((event) => event.phase === "page_running")
        .map((event) => event.pageIndex),
    ).toEqual([1, 2]);
  });

  it("accumulates context once after a retry and replaces it on retranslation", async () => {
    process.env.MANGA_TRANSLATOR_PAGE_RETRIES = "2";
    const page = makePage("page-a", "001.png");
    const workContext: PipelineWorkContext = {
      workId: "work-a",
      chapterId: "chapter-a",
      styleGuide: makeStyleGuide(),
      storyMemory: { ...makeStoryMemory(), pages: [] },
      recentPageCount: 6,
    };
    const success = translationWithPageContext("勇者", "용사", {
      visualSummary: "용사가 길을 나선다.",
      glossary: [{ source: "勇者", target: "용사", category: "term" }],
      characters: [],
    });
    const requestTranslation = vi
      .fn()
      .mockRejectedValueOnce(new Error("retry me"))
      .mockResolvedValue(success);
    const { runWholePagePipeline } = await loadPipeline({ requestTranslation });
    const options = {
      ...basePipelineOptions([page], []),
      collectPageContext: true,
      workContext,
    };

    await runWholePagePipeline(options);
    await runWholePagePipeline({
      ...options,
      jobId: "job-2",
      runPaths: basePipelineOptions([page], []).runPaths,
    });

    expect(requestTranslation).toHaveBeenCalledTimes(3);
    expect(
      workContext.styleGuide.glossary.filter(
        (entry) => entry.source === "勇者",
      ),
    ).toHaveLength(1);
    expect(
      workContext.storyMemory.pages.filter(
        (memory) => memory.pageId === page.id,
      ),
    ).toHaveLength(1);
  });

  it("keeps a valid translation when its page context JSON is malformed", async () => {
    process.env.MANGA_TRANSLATOR_PAGE_RETRIES = "2";
    const translated = successTranslationResult();
    const requestTranslation = vi.fn().mockResolvedValue({
      ...translated,
      outputText: `${translated.outputText}\n<page-context>{broken}</page-context>`,
    });
    const { runWholePagePipeline } = await loadPipeline({ requestTranslation });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([makePage("page-a", "001.png")], []),
      collectPageContext: true,
    });

    expect(requestTranslation).toHaveBeenCalledTimes(1);
    expect(result.pages[0]?.analysisStatus).toBe("completed");
    expect(result.warnings).toEqual([
      expect.stringContaining("페이지 컨텍스트 JSON을 읽지 못해"),
    ]);
  });

  it("does not accept a context-only response when OCR found source text", async () => {
    process.env.MANGA_TRANSLATOR_PAGE_RETRIES = "1";
    const requestTranslation = vi.fn().mockResolvedValue({
      outputText:
        '<page-context>{"visualSummary":"말풍선이 있는 장면","glossary":[],"characters":[]}</page-context>',
      rawResponse: {},
      requestBody: { noTextDetected: false },
    });
    const { runWholePagePipeline } = await loadPipeline({ requestTranslation });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([makePage("page-a", "001.png")], []),
      collectPageContext: true,
    });

    expect(requestTranslation).toHaveBeenCalledOnce();
    expect(result.pages[0]?.analysisStatus).toBe("failed");
  });

  it("does not accumulate context when the translated page is rejected", async () => {
    const workContext = {
      workId: "work-a",
      chapterId: "chapter-a",
      styleGuide: makeStyleGuide(),
      storyMemory: { ...makeStoryMemory(), pages: [] },
      recentPageCount: 6,
    };
    const requestTranslation = vi.fn().mockResolvedValue(
      translationWithPageContext("勇者", "용사", {
        visualSummary: "용사가 문 앞에 선다.",
        glossary: [{ source: "勇者", target: "용사", category: "term" }],
        characters: [],
      }),
    );
    const { runWholePagePipeline } = await loadPipeline({ requestTranslation });

    await runWholePagePipeline({
      ...basePipelineOptions([makePage("page-a", "001.png")], []),
      collectPageContext: true,
      workContext,
      onPageComplete: vi.fn().mockResolvedValue(false),
    });

    expect(workContext.styleGuide.glossary).toHaveLength(1);
    expect(workContext.storyMemory.pages).toEqual([]);
  });

  it("calls the model for a cumulative no-text page and stores its visual summary", async () => {
    const page = makePage("page-a", "001.png");
    const requestTranslation = vi.fn().mockResolvedValue({
      outputText:
        'not a valid translation record\n<page-context>{"visualSummary":"인물이 말없이 빈 방을 둘러본다.","glossary":[],"characters":[]}</page-context>',
      rawResponse: {},
      requestBody: { noTextDetected: true },
    });
    const workContext = {
      workId: "work-a",
      chapterId: "chapter-a",
      styleGuide: makeStyleGuide(),
      storyMemory: { ...makeStoryMemory(), pages: [] },
      recentPageCount: 6,
    };
    const { runWholePagePipeline } = await loadPipeline({
      ocrHintsByImagePath: new Map([
        [
          page.imagePath,
          {
            hints: [],
            diagnostics: [],
            noTextDetected: true,
            textEvidenceCount: 0,
          },
        ],
      ]),
      requestTranslation,
    });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([page], []),
      collectPageContext: true,
      workContext,
    });

    expect(requestTranslation).toHaveBeenCalledTimes(1);
    expect(result.pages[0]).toMatchObject({
      analysisStatus: "completed",
      blocks: [],
    });
    expect(workContext.storyMemory.pages[0]).toMatchObject({
      pageId: page.id,
      visualSummary: "인물이 말없이 빈 방을 둘러본다.",
    });
  });

  it("replaces stale snapshots for a standard no-text prepass page", async () => {
    const page = makePage("page-a", "001.png");
    const storyMemory = makeStoryMemory();
    storyMemory.pages.push({
      pageId: page.id,
      pageName: page.name,
      pageIndex: 9,
      sourceDigest: "old",
      translatedDigest: "old",
      summary: "old",
      glossaryEntryIds: ["glossary-1"],
      characterIds: ["character-old"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const workContext = {
      workId: "work-a",
      chapterId: "chapter-a",
      styleGuide: makeStyleGuide(),
      storyMemory,
      recentPageCount: 6,
    };
    const { runWholePagePipeline } = await loadPipeline({
      ocrHintsByImagePath: new Map([
        [
          page.imagePath,
          {
            hints: [],
            diagnostics: [],
            noTextDetected: true,
            textEvidenceCount: 0,
          },
        ],
      ]),
    });

    await runWholePagePipeline({
      ...basePipelineOptions([page], []),
      onPagesComplete: vi.fn(),
      workContext,
      canonicalPageIndexById: new Map([[page.id, 4]]),
    });

    expect(
      workContext.storyMemory.pages.find((memory) => memory.pageId === page.id),
    ).toMatchObject({
      pageIndex: 4,
      summary: "",
      glossaryEntryIds: [],
      characterIds: [],
    });
  });

  it("returns completed and failed pages for a partial page failure", async () => {
    process.env.MANGA_TRANSLATOR_PAGE_RETRIES = "1";
    const firstPage = makePage("page-a", "001.png");
    const secondPage = makePage("page-b", "002.png");
    const requestTranslation = vi.fn(
      async (_server: unknown, options: TranslationOptions) => {
        if (options.imagePath === secondPage.imagePath) {
          throw new Error("bad response");
        }
        return successTranslationResult();
      },
    );
    const onPageFailed = vi.fn();
    const events: JobEvent[] = [];
    const { runWholePagePipeline } = await loadPipeline({
      requestTranslation,
    });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([firstPage, secondPage], events),
      onPageFailed,
    });

    expect(result.pages.map((page) => page.analysisStatus)).toEqual([
      "completed",
      "failed",
    ]);
    expect(result.pages[1]?.lastError).toBe("bad response");
    expect(onPageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: secondPage.id, analysisStatus: "failed" }),
      "bad response",
    );
    expect(events.map((event) => event.phase)).toContain("page_skipped");
    expect(result.warnings).toEqual([
      "002.png: 시도 1/1 실패 - bad response",
      "002.png: 1회 재시도 후 실패하여 이 페이지는 건너뜁니다. 마지막 오류: bad response",
    ]);
  });

  it("marks a requested page as no-text when the request summary says no text", async () => {
    const page = makePage("page-a", "001.png");
    const requestTranslation = vi.fn().mockResolvedValue({
      outputText: JSON.stringify({ items: [] }),
      rawResponse: {},
      requestBody: { noTextDetected: true },
    });
    const onPageComplete = vi.fn();
    const events: JobEvent[] = [];
    const { runWholePagePipeline } = await loadPipeline({
      requestTranslation,
    });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([page], events),
      onPageComplete,
      skipOcrPrepass: true,
    });

    expect(result.pages[0]).toMatchObject({
      id: page.id,
      analysisStatus: "completed",
      blocks: [],
    });
    expect(onPageComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: page.id, blocks: [] }),
    );
    expect(
      events.some((event) => event.progressText === "001.png 텍스트 없음"),
    ).toBe(true);
  });

  it("adds source-page OCR and work memory to selected-region crop requests", async () => {
    const sourcePage = makePage("page-source", "003.png", {
      width: 1000,
      height: 1400,
    });
    const cropPage = makePage("page-crop", "003-region.png", {
      imagePath: "C:\\crops\\003-region.png",
      width: 300,
      height: 400,
    });
    const requestTranslation = vi
      .fn()
      .mockResolvedValue(regionSuccessTranslationResult());
    const events: JobEvent[] = [];
    const { runWholePagePipeline } = await loadPipeline({
      ocrHintsByImagePath: new Map([
        [
          sourcePage.imagePath,
          {
            hints: [
              {
                id: 10,
                label: "ocr_textline",
                x1: 120,
                y1: 240,
                x2: 220,
                y2: 360,
                ocrText: "こんにちは",
                groupId: "G001",
                containerType: "same_text_container",
                rolePrior: "ordinary_mergeable",
                orderInGroup: 1,
                score: 0.98,
              },
              {
                id: 11,
                label: "ocr_textline",
                x1: 50,
                y1: 250,
                x2: 150,
                y2: 350,
                ocrText: "端の文字",
              },
              {
                id: 12,
                label: "ocr_textline",
                x1: 800,
                y1: 900,
                x2: 900,
                y2: 1000,
                ocrText: "外",
              },
            ],
            diagnostics: [],
            noTextDetected: false,
            textEvidenceCount: 3,
          },
        ],
      ]),
      requestTranslation,
    });

    await runWholePagePipeline({
      ...basePipelineOptions([cropPage], events),
      regionContext: {
        sourcePage,
        sourcePageIndex: 2,
        cropRect: { x: 100, y: 200, w: 300, h: 400 },
      },
      workContext: {
        workId: "work-a",
        chapterId: "chapter-a",
        styleGuide: makeStyleGuide(),
        storyMemory: makeStoryMemory(),
        recentPageCount: 2,
      },
      writeStoryMemory: false,
    });

    const options = requestTranslation.mock.calls[0]?.[1] as
      | TranslationOptions
      | undefined;
    expect(options).toBeTruthy();
    expect(options?.regionCropMode).toBe(true);
    expect(options?.regionContextImagePath).toBe(sourcePage.imagePath);
    expect(options?.regionContextImageWidth).toBe(1000);
    expect(options?.regionContextImageHeight).toBe(1400);
    expect(options?.regionContextCropRect).toEqual({
      x: 100,
      y: 200,
      w: 300,
      h: 400,
    });
    expect(options?.skipOcrBboxHints).toBeUndefined();
    expect(options?.ocrBboxHints).toEqual([
      expect.objectContaining({
        id: 1,
        x1: 20,
        y1: 40,
        x2: 120,
        y2: 160,
        ocrText: "こんにちは",
        groupId: "G001",
        containerType: "same_text_container",
        rolePrior: "ordinary_mergeable",
        orderInGroup: 1,
        score: 0.98,
      }),
      expect.objectContaining({
        id: 2,
        x1: 0,
        y1: 50,
        x2: 50,
        y2: 150,
        ocrText: "端の文字",
      }),
    ]);
    expect(JSON.stringify(options?.ocrBboxHints)).not.toContain("外");
    expect(options?.workContext?.styleGuide.glossary[0]?.target).toBe("마왕");
    expect(
      options?.workContext?.storyMemory.pages.map((page) => page.pageId),
    ).toEqual(["memory-0", "memory-1"]);
  });

  it("completes selected-region crop without adding blocks when item is null", async () => {
    const sourcePage = makePage("page-source", "004.png");
    const cropPage = makePage("page-crop", "004-region.png", {
      imagePath: "C:\\crops\\004-region.png",
      width: 240,
      height: 180,
    });
    const requestTranslation = vi
      .fn()
      .mockResolvedValue(regionNullTranslationResult());
    const onPageComplete = vi.fn();
    const events: JobEvent[] = [];
    const { runWholePagePipeline } = await loadPipeline({
      requestTranslation,
    });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([cropPage], events),
      onPageComplete,
      regionContext: {
        sourcePage,
        sourcePageIndex: 3,
        cropRect: { x: 50, y: 60, w: 240, h: 180 },
      },
    });

    expect(result.pages[0]).toMatchObject({
      id: cropPage.id,
      analysisStatus: "completed",
      blocks: [],
    });
    expect(onPageComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: cropPage.id, blocks: [] }),
    );
  });

  it("keeps selected-region sound text even when confidence is below full-page SFX threshold", async () => {
    const sourcePage = makePage("page-source", "005.png");
    const cropPage = makePage("page-crop", "005-region.png", {
      imagePath: "C:\\crops\\005-region.png",
      width: 240,
      height: 180,
    });
    const requestTranslation = vi
      .fn()
      .mockResolvedValue(regionSoundTranslationResult());
    const events: JobEvent[] = [];
    const { runWholePagePipeline } = await loadPipeline({
      requestTranslation,
    });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([cropPage], events),
      regionContext: {
        sourcePage,
        sourcePageIndex: 4,
        cropRect: { x: 50, y: 60, w: 240, h: 180 },
      },
    });

    expect(result.pages[0]).toMatchObject({
      id: cropPage.id,
      analysisStatus: "completed",
    });
    expect(result.pages[0]?.blocks).toHaveLength(1);
    expect(result.pages[0]?.blocks[0]).toMatchObject({
      sourceText: "スタコラサッサ",
      translatedText: "후다닥",
    });
    expect(result.warnings).toEqual([]);
  });

  it("still translates selected-region crops when source-page OCR says no text", async () => {
    const sourcePage = makePage("page-source", "006.png");
    const cropPage = makePage("page-crop", "006-region.png", {
      imagePath: "C:\\crops\\006-region.png",
      width: 240,
      height: 180,
    });
    const requestTranslation = vi
      .fn()
      .mockResolvedValue(regionSuccessTranslationResult());
    const events: JobEvent[] = [];
    const { runWholePagePipeline } = await loadPipeline({
      ocrHintsByImagePath: new Map([
        [
          sourcePage.imagePath,
          {
            hints: [],
            diagnostics: [],
            noTextDetected: true,
            textEvidenceCount: 0,
          },
        ],
      ]),
      requestTranslation,
    });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([cropPage], events),
      regionContext: {
        sourcePage,
        sourcePageIndex: 5,
        cropRect: { x: 50, y: 60, w: 240, h: 180 },
      },
    });

    expect(requestTranslation).toHaveBeenCalledTimes(1);
    expect(result.pages[0]?.analysisStatus).toBe("completed");
    expect(result.pages[0]?.blocks).toHaveLength(1);
  });

  it("fails selected-region crop when the model returns a different object shape", async () => {
    process.env.MANGA_TRANSLATOR_PAGE_RETRIES = "1";
    const sourcePage = makePage("page-source", "007.png");
    const cropPage = makePage("page-crop", "007-region.png", {
      imagePath: "C:\\crops\\007-region.png",
      width: 240,
      height: 180,
    });
    const requestTranslation = vi.fn().mockResolvedValue({
      outputText: JSON.stringify({
        item: {
          x1: 20,
          y1: 40,
          x2: 120,
          y2: 160,
          jp: "こんにちは",
          ko: "안녕",
        },
        extra: true,
      }),
      rawResponse: {},
      requestBody: {},
    });
    const onPageFailed = vi.fn();
    const events: JobEvent[] = [];
    const { runWholePagePipeline } = await loadPipeline({
      requestTranslation,
    });

    const result = await runWholePagePipeline({
      ...basePipelineOptions([cropPage], events),
      onPageFailed,
      regionContext: {
        sourcePage,
        sourcePageIndex: 6,
        cropRect: { x: 50, y: 60, w: 240, h: 180 },
      },
    });

    expect(result.pages[0]).toMatchObject({
      id: cropPage.id,
      analysisStatus: "failed",
      blocks: [],
    });
    expect(result.pages[0]?.lastError).toContain(
      "Region response contract violation",
    );
    expect(onPageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: cropPage.id, analysisStatus: "failed" }),
      expect.stringContaining("Region response contract violation"),
    );
  });
});

async function loadPipeline({
  ocrHintsByImagePath = new Map<string, OcrBboxResult>(),
  requestTranslation = vi.fn().mockResolvedValue(successTranslationResult()),
  sourceLanguage = "ja",
  startEndpointSession,
}: {
  ocrHintsByImagePath?: ReadonlyMap<string, OcrBboxResult>;
  requestTranslation?: TranslationRuntimePort["requestTranslation"];
  sourceLanguage?: string;
  startEndpointSession?: TranslationRuntimePort["startEndpointSession"];
} = {}): Promise<{
  runWholePagePipeline: (
    options: PipelineOptions,
  ) => ReturnType<typeof runWholePagePipelineWithDependencies>;
  runtime: {
    collectOcrHintsBatch: ReturnType<typeof vi.fn>;
    disposeEndpoint: ReturnType<typeof vi.fn>;
    saveArtifacts: ReturnType<typeof vi.fn>;
    saveChapterStoryMemory: ReturnType<typeof vi.fn>;
    saveWorkStyleGuide: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "mgt-pipeline-"));
  tempDirs.push(rootDir);
  const disposeEndpoint = vi.fn(async (): Promise<void> => undefined);
  const resolveOcrResult = (options: TranslationOptions): OcrBboxResult =>
    ocrHintsByImagePath.get(options.imagePath) ?? emptyOcrResult();
  const collectOcrHints = vi.fn<TranslationRuntimePort["collectOcrHints"]>(
    async (options) => resolveOcrResult(options),
  );
  const collectOcrHintsBatch = vi.fn<
    TranslationRuntimePort["collectOcrHintsBatch"]
  >(async (options) => options.map(resolveOcrResult));
  const saveArtifacts = vi.fn<TranslationRuntimePort["saveArtifacts"]>(
    async (): Promise<void> => undefined,
  );
  const endpointStarter =
    startEndpointSession ??
    vi.fn<TranslationRuntimePort["startEndpointSession"]>(async () => ({
      handle: {
        baseUrl: "http://127.0.0.1:39281",
        child: null,
        startedByScript: false,
      },
      dispose: disposeEndpoint,
    }));
  const saveChapterStoryMemory = vi.fn<
    WholePagePipelineDependencies["pageContext"]["saveChapterStoryMemory"]
  >(async (memory) => memory);
  const saveWorkStyleGuide = vi.fn<
    WholePagePipelineDependencies["pageContext"]["saveWorkStyleGuide"]
  >(async (guide) => guide);
  const info = vi.fn<WholePagePipelineDependencies["diagnostics"]["info"]>();
  const warn = vi.fn<WholePagePipelineDependencies["diagnostics"]["warn"]>();
  const error = vi.fn<WholePagePipelineDependencies["diagnostics"]["error"]>();
  const dependencies = {
    paths: makeAppPaths(rootDir),
    settings: {
      getAppSettings: vi.fn(async () => makeAppSettings(sourceLanguage)),
    },
    pageContext: { saveChapterStoryMemory, saveWorkStyleGuide },
    diagnostics: { info, warn, error },
    runtime: {
      isModelCached: () => true,
      startEndpointSession: endpointStarter,
      collectOcrHints,
      collectOcrHintsBatch,
      requestTranslation,
      saveArtifacts,
      ...overlayParser,
    },
  } satisfies WholePagePipelineDependencies;
  return {
    runWholePagePipeline: (options) =>
      runWholePagePipelineWithDependencies(options, dependencies),
    runtime: {
      collectOcrHintsBatch,
      disposeEndpoint,
      saveArtifacts,
      saveChapterStoryMemory,
      saveWorkStyleGuide,
      info,
      warn,
      error,
    },
  };
}

function makeAppPaths(rootDir: string): AppPaths {
  return {
    isPackaged: false,
    repoRoot: rootDir,
    executableDir: rootDir,
    resourcesDir: rootDir,
    dataRoot: rootDir,
    settingsPath: join(rootDir, "settings.json"),
    libraryDir: join(rootDir, "library"),
    fontsDir: join(rootDir, "fonts"),
    logsDir: join(rootDir, "logs"),
    logFile: join(rootDir, "logs", "app.log"),
    runtimeDir: join(rootDir, "runtime"),
    toolsDir: join(rootDir, "tools"),
    ocrRuntimeDir: join(rootDir, "ocr-runtime"),
    llamaRuntimeDir: join(rootDir, "tools", "llama"),
    llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe"),
    hfHomeDir: join(rootDir, "hf-home"),
    hfHubCacheDir: join(rootDir, "hf-home", "hub"),
    llamaCacheDir: join(rootDir, "llama-cache"),
  };
}

function basePipelineOptions(
  pages: MangaPage[],
  events: JobEvent[],
): Parameters<
  (typeof import("../src/main/wholePagePipeline"))["runWholePagePipeline"]
>[0] {
  const rootDir = join(
    tmpdir(),
    `mgt-pipeline-run-${process.pid}-${runSequence++}`,
  );
  tempDirs.push(rootDir);
  return {
    jobId: "job-1",
    emit: (event) => events.push(event),
    pages,
    runPaths: {
      chapterDir: join(rootDir, "chapter"),
      runDir: join(rootDir, "run"),
    },
    signal: new AbortController().signal,
  };
}

function makeAppSettings(sourceLanguage: string): AppSettings {
  return {
    modelProvider: "gemma",
    translation: {
      sourceLanguage,
      targetLanguage: "ko",
    },
    gemma: {
      modelSource: "huggingface",
      modelRepo: "repo/model",
      modelFile: "model.gguf",
      vramMode: "minimum12b",
      llamaRuntimeProfile: "cuda12",
    },
    codex: {
      model: "gpt-5",
      reasoningEffort: "medium",
      oauthPort: 10531,
    },
    api: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5",
    },
    ocr: {
      device: "cpu",
      qualityMode: "minimum",
      gpuBackend: "cuda",
      gpuCudaTag: "cu124",
    },
    maxTokens: 4096,
    ctx: 131072,
  };
}

function emptyOcrResult(): OcrBboxResult {
  return {
    hints: [],
    diagnostics: [],
    noTextDetected: false,
    textEvidenceCount: 0,
  };
}

function makePage(
  id: string,
  name: string,
  overrides: Partial<MangaPage> = {},
): MangaPage {
  return {
    id,
    name,
    imagePath: `C:\\images\\${name}`,
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeStyleGuide(): WorkStyleGuide {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    workId: "work-a",
    glossary: [
      {
        id: "glossary-1",
        source: "魔王",
        target: "마왕",
        category: "term",
        aliases: ["魔王様"],
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    characters: [],
    rules: {
      honorifics: "adapt",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function makeStoryMemory(): ChapterStoryMemory {
  return {
    schemaVersion: 1,
    workId: "work-a",
    chapterId: "chapter-a",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pages: [0, 1, 2].map((pageIndex) => ({
      pageId: `memory-${pageIndex}`,
      pageName: `${pageIndex + 1}.png`,
      pageIndex,
      sourceDigest: `source ${pageIndex}`,
      translatedDigest: `translated ${pageIndex}`,
      summary: `summary ${pageIndex}`,
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}

function successTranslationResult(): {
  outputText: string;
  rawResponse: unknown;
  requestBody: unknown;
} {
  return {
    outputText: JSON.stringify({
      items: [
        {
          id: 1,
          type: "speech",
          x1: 100,
          y1: 100,
          x2: 300,
          y2: 200,
          jp: "こんにちは",
          ko: "안녕",
          direction: "horizontal",
          confidence: 0.95,
        },
      ],
    }),
    rawResponse: {},
    requestBody: {},
  };
}

function translationWithPageContext(
  source: string,
  target: string,
  pageContext: Record<string, unknown>,
): { outputText: string; rawResponse: unknown; requestBody: unknown } {
  return {
    outputText: `${JSON.stringify({
      items: [
        {
          id: 1,
          type: "speech",
          x1: 100,
          y1: 100,
          x2: 300,
          y2: 200,
          jp: source,
          ko: target,
          direction: "horizontal",
          confidence: 0.95,
        },
      ],
    })}\n<page-context>${JSON.stringify(pageContext)}</page-context>`,
    rawResponse: {},
    requestBody: {},
  };
}

function regionSuccessTranslationResult(): {
  outputText: string;
  rawResponse: unknown;
  requestBody: unknown;
} {
  return {
    outputText: JSON.stringify({
      item: {
        type: "nonsolid",
        textRole: "ordinary",
        x1: 20,
        y1: 40,
        x2: 120,
        y2: 160,
        jp: "こんにちは",
        ko: "안녕",
        direction: "horizontal",
        confidence: 0.95,
      },
    }),
    rawResponse: {},
    requestBody: {},
  };
}

function regionNullTranslationResult(): {
  outputText: string;
  rawResponse: unknown;
  requestBody: unknown;
} {
  return {
    outputText: JSON.stringify({ item: null }),
    rawResponse: {},
    requestBody: {},
  };
}

function regionSoundTranslationResult(): {
  outputText: string;
  rawResponse: unknown;
  requestBody: unknown;
} {
  return {
    outputText: JSON.stringify({
      item: {
        type: "nonsolid",
        textRole: "sound",
        x1: 20,
        y1: 40,
        x2: 220,
        y2: 160,
        jp: "スタコラサッサ",
        ko: "후다닥",
        direction: "vertical",
        confidence: 0.95,
      },
    }),
    rawResponse: {},
    requestBody: {},
  };
}
