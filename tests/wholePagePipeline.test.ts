import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChapterStoryMemory,
  JobEvent,
  MangaPage,
  WorkStyleGuide,
} from "../src/shared/types";
import type { TranslationOptions } from "../src/main/appSettings";
import type { OcrBboxResult } from "../src/main/pipeline/types";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.resetModules();
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
    expect(runtime.disposeEndpoint).toHaveBeenCalledTimes(1);
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

    await expect(
      runWholePagePipeline({
        ...basePipelineOptions([makePage("page-a", "001.png")], []),
        onPageFailed,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(requestTranslation).toHaveBeenCalledTimes(1);
    expect(onPageFailed).not.toHaveBeenCalled();
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
    const { runWholePagePipeline } = await loadPipeline({
      ocrHintsByPageId: new Map([
        [
          page.id,
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
      ocrHintsByPageId: new Map([
        [
          sourcePage.id,
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
      ocrHintsByPageId: new Map([
        [
          sourcePage.id,
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
  ocrHintsByPageId = new Map<string, OcrBboxResult>(),
  requestTranslation = vi.fn().mockResolvedValue(successTranslationResult()),
  startEndpointSession,
}: {
  ocrHintsByPageId?: Map<string, OcrBboxResult>;
  requestTranslation?: ReturnType<typeof vi.fn>;
  startEndpointSession?: ReturnType<typeof vi.fn>;
} = {}): Promise<{
  runWholePagePipeline: (typeof import("../src/main/wholePagePipeline"))["runWholePagePipeline"];
  runtime: { disposeEndpoint: ReturnType<typeof vi.fn> };
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "mgt-pipeline-"));
  tempDirs.push(rootDir);
  const disposeEndpoint = vi.fn(async () => undefined);
  const endpointStarter =
    startEndpointSession ??
    vi.fn(async () => ({
      handle: {
        baseUrl: "http://127.0.0.1:39281",
        child: null,
        startedByScript: false,
      },
      dispose: disposeEndpoint,
    }));

  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
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
    }),
  }));
  vi.doMock("../src/main/settingsStore", () => ({
    getAppSettings: vi.fn(async () => ({})),
  }));
  vi.doMock("../src/main/logger", () => ({
    logError: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
  }));
  vi.doMock("../src/main/pipeline/ocrHints", () => ({
    prepareOcrHintsForPages: vi.fn(async () => ocrHintsByPageId),
  }));
  vi.doMock("../src/main/pipeline/options", () => ({
    buildBaseOptions: (_jobId: string, runDir: string) =>
      makeBaseOptions(runDir),
    buildPageOptions: (
      baseOptions: TranslationOptions,
      page: MangaPage,
      _index: number,
      attempt: number,
    ) => ({
      ...baseOptions,
      imagePath: page.imagePath,
      imageWidth: page.width,
      imageHeight: page.height,
      outputDir: join(baseOptions.outputDir, "pages", page.id, `${attempt}`),
      label: `${page.id}-${attempt}`,
    }),
    formatGemmaVramMode: () => "12B 최소 모드",
    readNumberEnv: (name: string, fallback: number) => {
      const value = Number(process.env[name]);
      return Number.isFinite(value) ? value : fallback;
    },
    summarizePreview: (text: string) => text.slice(0, 40),
    summarizeTranslationOptions: (options: TranslationOptions) => ({
      label: options.label,
    }),
  }));
  vi.doMock("../src/main/pipeline/translationRuntimePort", () => ({
    loadTranslationRuntimePort: () => ({
      isModelCached: () => true,
      startEndpointSession: endpointStarter,
      requestTranslation,
      saveArtifacts: vi.fn(async () => undefined),
      parseJsonLenient: (rawText: string) => JSON.parse(rawText),
      parseRegionSingleItem: parseRegionSingleItemForTest,
      normalizeItems: (parsed: { items?: unknown[] }) => parsed.items ?? [],
      normalizeRegionSingleItem: normalizeRegionSingleItemForTest,
    }),
  }));

  const pipeline = await import("../src/main/wholePagePipeline");
  return {
    runWholePagePipeline: pipeline.runWholePagePipeline,
    runtime: { disposeEndpoint },
  };
}

function basePipelineOptions(
  pages: MangaPage[],
  events: JobEvent[],
): Parameters<
  (typeof import("../src/main/wholePagePipeline"))["runWholePagePipeline"]
>[0] {
  return {
    jobId: "job-1",
    emit: (event) => events.push(event),
    pages,
    runPaths: {
      chapterDir: join(tmpdir(), "chapter"),
      runDir: join(tmpdir(), "run"),
    },
    signal: new AbortController().signal,
  };
}

function makeBaseOptions(runDir: string): TranslationOptions {
  return {
    imagePath: "",
    outputDir: join(runDir, "analysis"),
    modelProvider: "gemma",
    port: 39281,
    promptMode: "default",
    temperature: 0,
    topP: 1,
    topK: 1,
    maxTokens: 4096,
    ctx: 131072,
    batch: 128,
    ubatch: 128,
    gemmaVramMode: "minimum12b",
    fitTargetMb: 1024,
    imageMinTokens: 256,
    imageMaxTokens: 1024,
    includeEnhancedVariant: false,
    enhancedMaxLongSide: 1900,
    enhancedContrast: 1,
    imageFirst: false,
    reuseServer: true,
    workingDir: runDir,
    toolsDir: join(runDir, "tools"),
    serverPath: join(runDir, "llama-server.exe"),
    modelSource: "huggingface",
    modelRepo: "repo/model",
    modelFile: "model.gguf",
    codexModel: "gpt-5",
    codexReasoningEffort: "medium",
    codexOauthPort: 10531,
    apiBaseUrl: "https://api.openai.com/v1",
    apiModel: "gpt-5",
    ocrDevice: "cpu",
    label: "base",
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
          bbox: { x: 100, y: 100, w: 200, h: 100 },
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

function parseRegionSingleItemForTest(rawText: string): unknown {
  const parsed = JSON.parse(rawText) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Region response contract violation");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "item") {
    throw new Error("Region response contract violation");
  }
  if (
    record.item !== null &&
    (!record.item ||
      typeof record.item !== "object" ||
      Array.isArray(record.item))
  ) {
    throw new Error("Region response contract violation");
  }
  return parsed;
}

function normalizeRegionSingleItemForTest(parsed: unknown): unknown[] {
  const item = (parsed as { item: Record<string, unknown> | null }).item;
  if (item === null) {
    return [];
  }
  const x1 = Number(item.x1);
  const y1 = Number(item.y1);
  const x2 = Number(item.x2);
  const y2 = Number(item.y2);
  return [
    {
      ...item,
      id: 1,
      type: "nonsolid",
      textRole: item.textRole ?? "ordinary",
      bbox: {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1),
      },
    },
  ];
}
