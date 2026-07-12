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
import type { OcrBboxResult } from "../src/main/pipeline/types";
import type { TranslationRuntimePort } from "../src/main/pipeline/translationRuntimePort";

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
    expect(requestTranslation.mock.calls[1]?.[1]).toMatchObject({
      imagePath: "C:\\images\\001.png",
      label: "page-1-attempt-2",
      pageId: "page-a",
      pageIndex: 0,
    });
    expect(runtime.saveArtifacts).toHaveBeenCalledOnce();
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
    const requestTranslation = vi
      .fn()
      .mockResolvedValue(successTranslationResult());
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

    await runWholePagePipeline({
      ...basePipelineOptions([page], []),
    });

    expect(startEndpointSession).toHaveBeenCalledTimes(1);
    expect(requestTranslation).toHaveBeenCalledTimes(1);
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
  requestTranslation?: ReturnType<typeof vi.fn>;
  sourceLanguage?: string;
  startEndpointSession?: ReturnType<typeof vi.fn>;
} = {}): Promise<{
  runWholePagePipeline: (typeof import("../src/main/wholePagePipeline"))["runWholePagePipeline"];
  runtime: {
    collectOcrHintsBatch: ReturnType<typeof vi.fn>;
    disposeEndpoint: ReturnType<typeof vi.fn>;
    saveArtifacts: ReturnType<typeof vi.fn>;
  };
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "mgt-pipeline-"));
  tempDirs.push(rootDir);
  const disposeEndpoint = vi.fn(async () => undefined);
  const resolveOcrResult = (options: TranslationOptions): OcrBboxResult =>
    ocrHintsByImagePath.get(options.imagePath) ?? emptyOcrResult();
  const collectOcrHints = vi.fn(async (options: TranslationOptions) =>
    resolveOcrResult(options),
  );
  const collectOcrHintsBatch = vi.fn(async (options: TranslationOptions[]) =>
    options.map(resolveOcrResult),
  );
  const saveArtifacts = vi.fn(async () => undefined);
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
      hfHomeDir: join(rootDir, "hf-home"),
      hfHubCacheDir: join(rootDir, "hf-home", "hub"),
      llamaCacheDir: join(rootDir, "llama-cache"),
    }),
  }));
  vi.doMock("../src/main/settingsStore", () => ({
    getAppSettings: vi.fn(async () => makeAppSettings(sourceLanguage)),
  }));
  vi.doMock("../src/main/logger", () => ({
    logError: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
  }));
  vi.doMock("../src/main/pipeline/translationRuntimePort", () => ({
    loadTranslationRuntimePort: () => ({
      isModelCached: () => true,
      startEndpointSession: endpointStarter,
      collectOcrHints,
      collectOcrHintsBatch,
      requestTranslation,
      saveArtifacts,
      ...overlayParser,
    }),
  }));

  const pipeline = await import("../src/main/wholePagePipeline");
  return {
    runWholePagePipeline: pipeline.runWholePagePipeline,
    runtime: { collectOcrHintsBatch, disposeEndpoint, saveArtifacts },
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
