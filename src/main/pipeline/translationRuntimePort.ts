import type { TranslationOptions } from "../appSettings";
import {
  isHayaiOcrPipeline,
  resolveOcrPipeline,
} from "../../shared/ocrEngines";
import { tMain } from "./localization";
import type {
  ModelEndpointHandle,
  OcrBboxResult,
  OverlayItem,
  RuntimeModules,
  TranslationResult,
} from "./types";
import { startModelEndpointSession } from "./runtimeModules";
import type { OcrGroupingEvidencePort } from "./ocrGroupingEvidencePort";

type TranslationEndpointSession = {
  readonly handle: ModelEndpointHandle;
  dispose: () => Promise<void>;
};

export type TranslationRuntimePort = {
  isModelCached: (options: TranslationOptions) => boolean;
  startEndpointSession: (
    options: TranslationOptions,
  ) => Promise<TranslationEndpointSession>;
  collectOcrHints: (options: TranslationOptions) => Promise<OcrBboxResult>;
  collectOcrHintsBatch: (
    options: TranslationOptions[],
  ) => Promise<OcrBboxResult[]>;
  annotateOcrGroupingEvidenceBatch: (
    options: TranslationOptions[],
    results: OcrBboxResult[],
  ) => Promise<OcrBboxResult[]>;
  requestTranslation: (
    endpoint: ModelEndpointHandle,
    options: TranslationOptions,
  ) => Promise<TranslationResult>;
  saveArtifacts: (
    options: TranslationOptions,
    result: TranslationResult,
  ) => Promise<void>;
  parseJsonLenient: (rawText: string) => unknown;
  parseRegionSingleItem: (rawText: string) => unknown;
  normalizeItems: (parsed: unknown) => OverlayItem[];
  normalizeRegionSingleItem: (parsed: unknown) => OverlayItem[];
};

export type GpuMemoryCoordinator = {
  releaseIdleResources: (reason: string) => Promise<boolean>;
};

export type HayaiOcrRegionPrepassPort = {
  prepare: (options: TranslationOptions) => Promise<{
    manifestPath: string;
    finalize: (result: OcrBboxResult) => Promise<OcrBboxResult>;
  }>;
  releaseDetectorResources: (reason: string) => Promise<boolean>;
};

async function releaseGpuBeforeOcr(
  gpuMemory: GpuMemoryCoordinator,
  optionsList: TranslationOptions[],
): Promise<void> {
  const gpuOptions = optionsList.find(
    (options) => options.ocrDevice === "gpu" && !options.skipOcrBboxHints,
  );
  if (!gpuOptions) {
    return;
  }
  const disposed = await gpuMemory.releaseIdleResources("ocr-gpu-start");
  if (disposed) {
    gpuOptions.onProgress?.({
      phase: "ocr_running",
      progressText: tMain("ocr.gpuCacheReleased"),
      detail: tMain("ocr.gpuCacheReleasedDetail"),
      progressMode: "log-only",
    });
  }
}

async function releaseInpaintingBeforeGemma(
  gpuMemory: GpuMemoryCoordinator,
  options: TranslationOptions,
): Promise<void> {
  if (options.modelProvider !== "gemma") {
    return;
  }
  const disposed = await gpuMemory.releaseIdleResources("gemma-start");
  if (disposed) {
    options.onProgress?.({
      phase: "booting",
      progressText: "Gemma용 통합 메모리 확보",
      detail:
        "캐시된 인페인팅 모델을 내려 Gemma와 대형 모델이 동시에 상주하지 않게 했습니다.",
      progressMode: "log-only",
    });
  }
}

export function createTranslationRuntimePort({
  gpuMemory,
  groupingEvidence,
  hayaiRegionPrepass,
  runtime,
}: {
  gpuMemory: GpuMemoryCoordinator;
  groupingEvidence: OcrGroupingEvidencePort;
  hayaiRegionPrepass: HayaiOcrRegionPrepassPort;
  runtime: RuntimeModules;
}): TranslationRuntimePort {
  return {
    isModelCached: (options) => runtime.simplePage.isModelCached(options),
    startEndpointSession: async (options) => {
      await runtime.simplePage.waitForOcrIdle?.();
      const detectorDisposed =
        await hayaiRegionPrepass.releaseDetectorResources(
          "translation-model-start",
        );
      if (detectorDisposed) {
        emitDetectorReleasedBeforeTranslation(options);
      }
      await groupingEvidence.releaseIdleResources("translation-model-start");
      await releaseInpaintingBeforeGemma(gpuMemory, options);
      return startModelEndpointSession(runtime, options);
    },
    collectOcrHints: (options) =>
      collectOcrHints({
        gpuMemory,
        groupingEvidence,
        hayaiRegionPrepass,
        runtime,
        options,
      }),
    collectOcrHintsBatch: (optionsList) =>
      collectOcrHintsBatch({
        gpuMemory,
        groupingEvidence,
        hayaiRegionPrepass,
        runtime,
        optionsList,
      }),
    annotateOcrGroupingEvidenceBatch: (optionsList, results) =>
      groupingEvidence.annotateBatch(optionsList, results),
    requestTranslation: (endpoint, options) =>
      runtime.simplePage.requestTranslation(endpoint, options),
    saveArtifacts: (options, result) =>
      runtime.simplePage.saveArtifacts(options, result),
    parseJsonLenient: (rawText) =>
      runtime.overlayTools.parseJsonLenient(rawText),
    parseRegionSingleItem: (rawText) =>
      runtime.overlayTools.parseRegionSingleItem(rawText),
    normalizeItems: (parsed) => runtime.overlayTools.normalizeItems(parsed),
    normalizeRegionSingleItem: (parsed) =>
      runtime.overlayTools.normalizeRegionSingleItem(parsed),
  };
}

async function collectOcrHints({
  gpuMemory,
  groupingEvidence,
  hayaiRegionPrepass,
  runtime,
  options,
}: {
  gpuMemory: GpuMemoryCoordinator;
  groupingEvidence: OcrGroupingEvidencePort;
  hayaiRegionPrepass: HayaiOcrRegionPrepassPort;
  runtime: RuntimeModules;
  options: TranslationOptions;
}): Promise<OcrBboxResult> {
  await releaseGpuBeforeOcr(gpuMemory, [options]);
  if (isHayaiOcrPipeline(options.ocrPipeline)) {
    const [prepared] = await prepareHayaiRegionStage(hayaiRegionPrepass, [
      options,
    ]);
    const result = await runtime.simplePage.collectOcrBboxHints({
      ...options,
      ocrBboxRegionsPath: prepared.manifestPath,
    });
    emitHayaiOcrProcessStopped(options);
    return prepared.finalize(result);
  }
  const result = await runtime.simplePage.collectOcrBboxHints(options);
  return groupingEvidence.annotate(options, result);
}

async function collectOcrHintsBatch({
  gpuMemory,
  groupingEvidence,
  hayaiRegionPrepass,
  runtime,
  optionsList,
}: {
  gpuMemory: GpuMemoryCoordinator;
  groupingEvidence: OcrGroupingEvidencePort;
  hayaiRegionPrepass: HayaiOcrRegionPrepassPort;
  runtime: RuntimeModules;
  optionsList: TranslationOptions[];
}): Promise<OcrBboxResult[]> {
  assertUniformOcrBatchProfile(optionsList);
  await releaseGpuBeforeOcr(gpuMemory, optionsList);
  if (!isHayaiOcrPipeline(optionsList[0]?.ocrPipeline)) {
    const results = runtime.simplePage.collectOcrBboxHintsBatch
      ? await runtime.simplePage.collectOcrBboxHintsBatch(optionsList)
      : await collectSequentialOcr(runtime, optionsList);
    return groupingEvidence.annotateBatch(optionsList, results);
  }
  const prepared = await prepareHayaiRegionStage(
    hayaiRegionPrepass,
    optionsList,
  );
  const runtimeOptions = optionsList.map((options, index) => ({
    ...options,
    ocrBboxRegionsPath: prepared[index].manifestPath,
  }));
  const results = runtime.simplePage.collectOcrBboxHintsBatch
    ? await runtime.simplePage.collectOcrBboxHintsBatch(runtimeOptions)
    : await collectSequentialOcr(runtime, runtimeOptions);
  const progressOptions = optionsList[0];
  if (progressOptions) {
    emitHayaiOcrProcessStopped(progressOptions);
  }
  return Promise.all(
    results.map((result, index) => prepared[index].finalize(result)),
  );
}

type PreparedHayaiRegions = Awaited<
  ReturnType<HayaiOcrRegionPrepassPort["prepare"]>
>;

async function prepareHayaiRegionStage(
  prepass: HayaiOcrRegionPrepassPort,
  optionsList: TranslationOptions[],
): Promise<PreparedHayaiRegions[]> {
  const prepared: PreparedHayaiRegions[] = [];
  let preparationFailed = false;
  let preparationError: unknown;
  try {
    for (const options of optionsList) {
      prepared.push(await prepass.prepare(options));
    }
  } catch (error) {
    preparationFailed = true;
    preparationError = error;
  }

  let detectorDisposed: boolean;
  try {
    detectorDisposed = await prepass.releaseDetectorResources(
      preparationFailed
        ? "hayai-region-prepass-failed"
        : "hayai-region-prepass-complete",
    );
  } catch (disposalError) {
    if (preparationFailed) {
      throw new AggregateError(
        [preparationError, disposalError],
        "Text Detector failed and its runtime could not be released.",
        { cause: disposalError },
      );
    }
    throw disposalError;
  }

  const progressOptions = optionsList[0];
  if (detectorDisposed && progressOptions) {
    emitDetectorReleasedBeforeHayai(progressOptions);
  }
  if (preparationFailed) {
    throw preparationError;
  }
  return prepared;
}

function emitDetectorReleasedBeforeHayai(options: TranslationOptions): void {
  options.onProgress?.({
    phase: "ocr_preparing",
    progressText: tMain("ocr.detectorReleased"),
    detail: tMain("ocr.detectorReleasedDetail"),
    progressMode: "log-only",
  });
}

function emitDetectorReleasedBeforeTranslation(
  options: TranslationOptions,
): void {
  options.onProgress?.({
    phase: "booting",
    progressText: tMain("ocr.detectorReleasedBeforeTranslation"),
    detail: tMain("ocr.detectorReleasedBeforeTranslationDetail"),
    progressMode: "log-only",
  });
}

function emitHayaiOcrProcessStopped(options: TranslationOptions): void {
  options.onProgress?.({
    phase: "ocr_running",
    progressText: tMain("ocr.hayaiProcessStopped"),
    detail: tMain("ocr.hayaiProcessStoppedDetail"),
    progressMode: "log-only",
  });
}

const OCR_BATCH_PROFILE_KEYS = [
  "ocrPipeline",
  "ocrDevice",
  "ocrGpuBackend",
  "ocrGpuCudaTag",
  "ocrQualityMode",
  "ocrBboxProvider",
  "ocrBboxMode",
  "ocrEngine",
  "ocrEngineDtype",
  "ocrVersion",
  "ocrTextDetectionModelName",
  "ocrTextRecognitionModelName",
  "ocrMergeMode",
  "ocrDetLimit",
  "ocrRecBatch",
] as const satisfies ReadonlyArray<keyof TranslationOptions>;

function assertUniformOcrBatchProfile(optionsList: TranslationOptions[]): void {
  if (optionsList.length < 2) return;
  const expected = buildOcrBatchProfileKey(optionsList[0]);
  const mismatchIndex = optionsList.findIndex(
    (options) => buildOcrBatchProfileKey(options) !== expected,
  );
  if (mismatchIndex > 0) {
    throw new TypeError(
      `OCR batch item ${mismatchIndex + 1} has a different runtime profile. Split mixed engine/device profiles into separate batches.`,
    );
  }
}

function buildOcrBatchProfileKey(options: TranslationOptions): string {
  return JSON.stringify(
    OCR_BATCH_PROFILE_KEYS.map((key) =>
      key === "ocrPipeline"
        ? resolveOcrPipeline(options.ocrPipeline)
        : (options[key] ?? null),
    ),
  );
}

async function collectSequentialOcr(
  runtime: RuntimeModules,
  optionsList: TranslationOptions[],
): Promise<OcrBboxResult[]> {
  const results: OcrBboxResult[] = [];
  for (const options of optionsList) {
    results.push(await runtime.simplePage.collectOcrBboxHints(options));
  }
  return results;
}
