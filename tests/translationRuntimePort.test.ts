import { describe, expect, it, vi } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";

type ProgressEvent = { progressText: string; phase: string };

async function loadPortWithStubs({ disposed = true } = {}) {
  vi.resetModules();
  const calls: string[] = [];
  const collectOptions: Array<Record<string, unknown>> = [];
  const disposeCachedInpaintingEngines = vi.fn(async (_reason: string) => {
    calls.push("dispose");
    return disposed;
  });

  vi.doMock("../src/main/inpainting/inpaintingEnginePool", () => ({
    disposeCachedInpaintingEngines,
  }));
  vi.doMock("../src/main/pipeline/runtimeModules", () => ({
    loadRuntimeModules: () => ({
      simplePage: {
        isModelCached: () => true,
        collectOcrBboxHints: async (options: Record<string, unknown>) => {
          calls.push("ocr");
          collectOptions.push(options);
          return {
            hints: [],
            diagnostics: [],
            noTextDetected: false,
            textEvidenceCount: 0,
          };
        },
        collectOcrBboxHintsBatch: async (
          optionsList: Array<Record<string, unknown>>,
        ) => {
          calls.push("ocr-batch");
          return optionsList.map(() => ({
            hints: [],
            diagnostics: [],
            noTextDetected: false,
            textEvidenceCount: 0,
          }));
        },
        requestTranslation: async () => ({}),
        saveArtifacts: async () => undefined,
      },
      overlayTools: {
        parseJsonLenient: (rawText: string) => JSON.parse(rawText),
        parseRegionSingleItem: () => null,
        normalizeItems: () => [],
        normalizeRegionSingleItem: () => [],
      },
    }),
    startModelEndpointSession: async () => ({}),
  }));

  const portModule =
    await import("../src/main/pipeline/translationRuntimePort");
  return {
    port: portModule.loadTranslationRuntimePort(),
    disposeCachedInpaintingEngines,
    calls,
    collectOptions,
  };
}

function makeOcrOptions(
  overrides: Record<string, unknown> = {},
): TranslationOptions {
  return {
    imagePath: "C:/pages/page-1.png",
    outputDir: "C:/runs/analysis",
    ocrDevice: "gpu",
    ...overrides,
  } as unknown as TranslationOptions;
}

describe("translationRuntimePort GPU OCR preparation", () => {
  it("disposes cached inpainting engines before GPU OCR to free VRAM", async () => {
    const { port, disposeCachedInpaintingEngines, calls } =
      await loadPortWithStubs();
    const progressEvents: ProgressEvent[] = [];

    await port.collectOcrHints(
      makeOcrOptions({
        onProgress: (event: ProgressEvent) => progressEvents.push(event),
      }),
    );

    expect(disposeCachedInpaintingEngines).toHaveBeenCalledWith(
      "ocr-gpu-start",
    );
    expect(calls).toEqual(["dispose", "ocr"]);
    expect(progressEvents).toContainEqual(
      expect.objectContaining({
        progressText: "GPU OCR을 위해 인페인팅 엔진 캐시를 해제했습니다",
      }),
    );
  });

  it("stays quiet when there was no cached engine to dispose", async () => {
    const { port } = await loadPortWithStubs({ disposed: false });
    const progressEvents: ProgressEvent[] = [];

    await port.collectOcrHints(
      makeOcrOptions({
        onProgress: (event: ProgressEvent) => progressEvents.push(event),
      }),
    );

    expect(progressEvents).toHaveLength(0);
  });

  it("keeps the inpainting cache warm for CPU OCR and skipped hints", async () => {
    const { port, disposeCachedInpaintingEngines, calls } =
      await loadPortWithStubs();

    await port.collectOcrHints(makeOcrOptions({ ocrDevice: "cpu" }));
    await port.collectOcrHints(makeOcrOptions({ skipOcrBboxHints: true }));

    expect(disposeCachedInpaintingEngines).not.toHaveBeenCalled();
    expect(calls).toEqual(["ocr", "ocr"]);
  });

  it("disposes once before a GPU OCR batch", async () => {
    const { port, disposeCachedInpaintingEngines, calls } =
      await loadPortWithStubs();

    await port.collectOcrHintsBatch([
      makeOcrOptions({ ocrDevice: "cpu" }),
      makeOcrOptions(),
    ]);

    expect(disposeCachedInpaintingEngines).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["dispose", "ocr-batch"]);
  });
});
