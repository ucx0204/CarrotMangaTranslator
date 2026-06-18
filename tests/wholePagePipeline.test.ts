import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobEvent, MangaPage } from "../src/shared/types";
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
      normalizeItems: (parsed: { items?: unknown[] }) => parsed.items ?? [],
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
    maxTokens: 1000,
    ctx: 4096,
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

function makePage(id: string, name: string): MangaPage {
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
