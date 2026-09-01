import { describe, expect, it, vi } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import { createTranslationRuntimePort } from "../src/main/pipeline/translationRuntimePort";
import type { RuntimeModules } from "../src/main/pipeline/types";

type ProgressEvent = { progressText: string; phase: string };

function createPortWithStubs({
  disposed = true,
  detectorFailureImage,
  detectorFailure = new Error("detector failed"),
}: {
  disposed?: boolean;
  detectorFailureImage?: string;
  detectorFailure?: Error;
} = {}) {
  const calls: string[] = [];
  const collectOptions: Array<Record<string, unknown>> = [];
  const releaseIdleResources = vi.fn(async (_reason: string) => {
    calls.push("dispose");
    return disposed;
  });
  const releaseGroupingEvidence = vi.fn(async () => false);
  const waitForOcrIdle = vi.fn(async () => {
    calls.push("ocr-idle");
  });
  const releaseDetectorResources = vi.fn(async (reason: string) => {
    calls.push(`detector-release:${reason}`);
    return true;
  });
  const prepareDetectorRegions = vi.fn(async (options: TranslationOptions) => {
    calls.push(`detector:${options.imagePath}`);
    if (options.imagePath === detectorFailureImage) {
      throw detectorFailure;
    }
    return {
      manifestPath: `${options.outputDir}/hayai-regions.json`,
      finalize: async (
        result: Awaited<
          ReturnType<RuntimeModules["simplePage"]["collectOcrBboxHints"]>
        >,
      ) => result,
    };
  });
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
      waitForOcrIdle,
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
      hayaiRegionPrepass: {
        prepare: prepareDetectorRegions,
        releaseDetectorResources,
      },
      runtime,
    }),
    releaseIdleResources,
    releaseGroupingEvidence,
    releaseDetectorResources,
    prepareDetectorRegions,
    waitForOcrIdle,
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
    expect(calls).toEqual([
      "ocr-idle",
      "detector-release:translation-model-start",
      "dispose",
      "endpoint",
    ]);
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
    expect(calls).toEqual([
      "ocr-idle",
      "detector-release:translation-model-start",
    ]);
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
      makeOcrOptions(),
      makeOcrOptions({ imagePath: "C:/pages/page-2.png" }),
    ]);

    expect(releaseIdleResources).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["dispose", "ocr-batch"]);
  });

  it("runs every detector page, releases it, runs HayaiOCR, then waits for OCR closure before Gemma", async () => {
    const {
      port,
      releaseDetectorResources,
      prepareDetectorRegions,
      waitForOcrIdle,
      calls,
    } = createPortWithStubs();

    const first = makeOcrOptions({
      ocrPipeline: "hayai",
      ocrBboxProvider: "hayai-regions",
    });
    const second = makeOcrOptions({
      imagePath: "C:/pages/page-2.png",
      outputDir: "C:/runs/analysis/page-2",
      ocrPipeline: "hayai",
      ocrBboxProvider: "hayai-regions",
    });
    await port.collectOcrHintsBatch([first, second]);
    await port.startEndpointSession(
      makeOcrOptions({ modelProvider: "gemma", ocrDevice: "cpu" }),
    );

    expect(prepareDetectorRegions).toHaveBeenCalledTimes(2);
    expect(releaseDetectorResources).toHaveBeenNthCalledWith(
      1,
      "hayai-region-prepass-complete",
    );
    expect(waitForOcrIdle).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      "dispose",
      "detector:C:/pages/page-1.png",
      "detector:C:/pages/page-2.png",
      "detector-release:hayai-region-prepass-complete",
      "ocr-batch",
      "ocr-idle",
      "detector-release:translation-model-start",
      "dispose",
      "endpoint",
    ]);
  });

  it("releases the detector and never starts HayaiOCR when region detection fails", async () => {
    const { port, releaseDetectorResources, calls } = createPortWithStubs({
      detectorFailureImage: "C:/pages/page-2.png",
    });

    await expect(
      port.collectOcrHintsBatch([
        makeOcrOptions({
          ocrPipeline: "hayai",
          ocrBboxProvider: "hayai-regions",
        }),
        makeOcrOptions({
          imagePath: "C:/pages/page-2.png",
          ocrPipeline: "hayai",
          ocrBboxProvider: "hayai-regions",
        }),
      ]),
    ).rejects.toThrow("detector failed");

    expect(releaseDetectorResources).toHaveBeenCalledWith(
      "hayai-region-prepass-failed",
    );
    expect(calls).not.toContain("ocr-batch");
  });

  it("releases the detector when Hayai region detection is cancelled", async () => {
    const { port, releaseDetectorResources, calls } = createPortWithStubs({
      detectorFailureImage: "C:/pages/page-1.png",
      detectorFailure: new DOMException("Aborted", "AbortError"),
    });

    await expect(
      port.collectOcrHints(
        makeOcrOptions({
          ocrPipeline: "hayai",
          ocrBboxProvider: "hayai-regions",
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(releaseDetectorResources).toHaveBeenCalledWith(
      "hayai-region-prepass-failed",
    );
    expect(calls).not.toContain("ocr");
  });

  it("rejects mixed OCR runtime profiles before releasing or launching", async () => {
    const { port, releaseIdleResources, calls } = createPortWithStubs();

    await expect(
      port.collectOcrHintsBatch([
        makeOcrOptions({
          ocrPipeline: "hayai",
          ocrBboxProvider: "hayai-regions",
          ocrDevice: "gpu",
        }),
        makeOcrOptions({
          ocrPipeline: "paddle-legacy",
          ocrBboxProvider: "paddleocr",
          ocrDevice: "cpu",
        }),
      ]),
    ).rejects.toThrow(/different runtime profile/i);

    expect(releaseIdleResources).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
