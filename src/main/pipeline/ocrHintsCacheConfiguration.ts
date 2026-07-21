import type { TranslationOptions } from "../appSettings";

type OcrHintCacheConfiguration = {
  ocrDevice: string | null;
  ocrGpuBackend: string | null;
  ocrGpuCudaTag: string | null;
  ocrQualityMode: string | null;
  ocrBboxProvider: string | null;
  ocrBboxMode: string | null;
  ocrEngine: string | null;
  ocrEngineDtype: string | null;
  ocrVersion: string | null;
  ocrTextDetectionModelName: string | null;
  ocrTextRecognitionModelName: string | null;
  ocrMergeMode: string | null;
  ocrDetLimit: string | null;
  ocrRecBatch: string | null;
  ocrBboxCommand: string | null;
  ocrBboxHintsPath: string | null;
};

const OCR_HINT_CACHE_CONFIGURATION_KEYS = [
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
  "ocrBboxCommand",
  "ocrBboxHintsPath",
] as const satisfies readonly (keyof OcrHintCacheConfiguration)[];

export function matchesOcrCacheConfiguration(
  cached: unknown,
  options: TranslationOptions,
): boolean {
  if (!cached || typeof cached !== "object" || Array.isArray(cached)) {
    return false;
  }
  const expected = buildOcrCacheConfiguration(options);
  const candidate = cached as Record<string, unknown>;
  return OCR_HINT_CACHE_CONFIGURATION_KEYS.every(
    (key) => candidate[key] === expected[key],
  );
}

export function buildOcrCacheConfiguration(
  options: TranslationOptions,
): OcrHintCacheConfiguration {
  return {
    ocrDevice: normalizeOcrCacheOption(options.ocrDevice),
    ocrGpuBackend: normalizeOcrCacheOption(options.ocrGpuBackend),
    ocrGpuCudaTag: normalizeOcrCacheOption(options.ocrGpuCudaTag),
    ocrQualityMode: normalizeOcrCacheOption(options.ocrQualityMode),
    ocrBboxProvider: normalizeOcrCacheOption(options.ocrBboxProvider),
    ocrBboxMode: normalizeOcrCacheOption(options.ocrBboxMode),
    ocrEngine: normalizeOcrCacheOption(options.ocrEngine),
    ocrEngineDtype: normalizeOcrCacheOption(options.ocrEngineDtype),
    ocrVersion: normalizeOcrCacheOption(options.ocrVersion),
    ocrTextDetectionModelName: normalizeOcrCacheOption(
      options.ocrTextDetectionModelName,
    ),
    ocrTextRecognitionModelName: normalizeOcrCacheOption(
      options.ocrTextRecognitionModelName,
    ),
    ocrMergeMode: normalizeOcrCacheOption(options.ocrMergeMode),
    ocrDetLimit: normalizeOcrCacheOption(options.ocrDetLimit),
    ocrRecBatch: normalizeOcrCacheOption(options.ocrRecBatch),
    ocrBboxCommand: normalizeOcrCacheOption(options.ocrBboxCommand),
    ocrBboxHintsPath: normalizeOcrCacheOption(options.ocrBboxHintsPath),
  };
}

function normalizeOcrCacheOption(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
