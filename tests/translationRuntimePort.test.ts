import { describe, expect, it, vi } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import { createTranslationRuntimePort } from "../src/main/pipeline/translationRuntimePort";
import type { RuntimeModules } from "../src/main/pipeline/types";

type ProgressEvent = { progressText: string; phase: string };

function createPortWithStubs({ disposed = true } = {}) {
  const calls: string[] = [];
  const collectOptions: Array<Record<string, unknown>> = [];
  const releaseIdleResources = vi.fn(async (_reason: string) => {
    calls.push("dispose");
    return disposed;
  });
  const releaseGroupingEvidence = vi.fn(async () => false);
  const runtime: RuntimeModules = {
    animeTextRelations: {
      hasPotentialAnimeTextRelation: () => false,
      qualifyAnimeTextRelationRegionIds: () => [],
    },
    simplePage: {
      isModelCached: () => true,
      startServer: async () => {
        calls.push("endpoint");
        return {
          baseUrl: "http://127.0.0.1:1234",
          child: null,
          startedByScript: false,
        };
      },
      stopServer: async () => undefined,
      collectOcrBboxHints: async (options) => {
        calls.push("ocr");
        collectOptions.push(options);
        return {
          hints: [],
          diagnostics: [],
          noTextDetected: false,
          textEvidenceCount: 0,
        };
      },
      collectOcrBboxHintsBatch: async (optionsList) => {
        calls.push("ocr-batch");
        return optionsList.map(() => ({
          hints: [],
          diagnostics: [],
          noTextDetected: false,
          textEvidenceCount: 0,
        }));
      },
      requestTranslation: async () => ({
        outputText: "",
        rawResponse: null,
        requestBody: null,
      }),
      saveArtifacts: async () => undefined,
    },
    overlayTools: {
      parseJsonLenient: (rawText) => JSON.parse(rawText),
      parseRegionSingleItem: () => null,
      normalizeItems: () => [],
      normalizeRegionSingleItem: () => [],
    },
  };
  return {
    port: createTranslationRuntimePort({
      gpuMemory: { releaseIdleResources },
      groupingEvidence: {
        annotate: async (_options, result) => result,
        annotateBatch: async (_options, results) => results,
        releaseIdleResources: releaseGroupingEvidence,
      },
      runtime,
    }),
    releaseIdleResources,
    releaseGroupingEvidence,
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
  } as TranslationOptions;
}

describe("translationRuntimePort GPU OCR preparation", () => {
  it("disposes cached inpainting before local Gemma starts", async () => {
    const { port, releaseGroupingEvidence, releaseIdleResources, calls } =
      createPortWithStubs();

    await port.startEndpointSession(
      makeOcrOptions({ modelProvider: "gemma", ocrDevice: "cpu" }),
    );

    expect(releaseIdleResources).toHaveBeenCalledWith("gemma-start");
    expect(releaseGroupingEvidence).toHaveBeenCalledWith(
      "translation-model-start",
    );
    expect(calls).toEqual(["dispose", "endpoint"]);
  });

  it("does not evict inpainting for remote translation providers", async () => {
    const { port, releaseGroupingEvidence, releaseIdleResources, calls } =
      createPortWithStubs();

    await port.startEndpointSession(
      makeOcrOptions({ modelProvider: "openai-api", ocrDevice: "cpu" }),
    );

    expect(releaseIdleResources).not.toHaveBeenCalled();
    expect(releaseGroupingEvidence).toHaveBeenCalledWith(
      "translation-model-start",
    );
    expect(calls).toEqual([]);
  });

  it("disposes cached inpainting engines before GPU OCR to free VRAM", async () => {
    const { port, releaseIdleResources, calls } = createPortWithStubs();
    const progressEvents: ProgressEvent[] = [];

    await port.collectOcrHints(
      makeOcrOptions({
        onProgress: (event: ProgressEvent) => progressEvents.push(event),
      }),
    );

    expect(releaseIdleResources).toHaveBeenCalledWith("ocr-gpu-start");
    expect(calls).toEqual(["dispose", "ocr"]);
    expect(progressEvents).toContainEqual(
      expect.objectContaining({
        progressText: "GPU OCR을 위해 인페인팅 엔진 캐시를 해제했습니다",
      }),
    );
  });

  it("stays quiet when there was no cached engine to dispose", async () => {
    const { port } = createPortWithStubs({ disposed: false });
    const progressEvents: ProgressEvent[] = [];

    await port.collectOcrHints(
      makeOcrOptions({
        onProgress: (event: ProgressEvent) => progressEvents.push(event),
      }),
    );

    expect(progressEvents).toHaveLength(0);
  });

  it("keeps the inpainting cache warm for CPU OCR and skipped hints", async () => {
    const { port, releaseIdleResources, calls } = createPortWithStubs();

    await port.collectOcrHints(makeOcrOptions({ ocrDevice: "cpu" }));
    await port.collectOcrHints(makeOcrOptions({ skipOcrBboxHints: true }));

    expect(releaseIdleResources).not.toHaveBeenCalled();
    expect(calls).toEqual(["ocr", "ocr"]);
  });

  it("disposes once before a GPU OCR batch", async () => {
    const { port, releaseIdleResources, calls } = createPortWithStubs();

    await port.collectOcrHintsBatch([
      makeOcrOptions({ ocrDevice: "cpu" }),
      makeOcrOptions(),
    ]);

    expect(releaseIdleResources).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["dispose", "ocr-batch"]);
  });
});
