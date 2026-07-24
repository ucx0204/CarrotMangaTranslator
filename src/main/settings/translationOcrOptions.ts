import { DEFAULT_OCR_GPU_CUDA_TAG } from "../../shared/modelPresets";
import type {
  AppSettings,
  GemmaVramMode,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
} from "../../shared/settingsTypes";
import type { TranslationOptions } from "./appSettingsTypes";
import {
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOcrQualityMode,
  resolveOptionalString,
} from "./appSettingsResolvers";
type OcrTranslationOptions = Pick<
  TranslationOptions,
  | "ocrDevice"
  | "ocrGpuBackend"
  | "ocrGpuCudaTag"
  | "ocrQualityMode"
  | "ocrBboxProvider"
  | "ocrBboxMode"
  | "ocrEngine"
  | "ocrEngineDtype"
  | "ocrVersion"
  | "ocrTextDetectionModelName"
  | "ocrTextRecognitionModelName"
  | "ocrMergeMode"
  | "ocrDetLimit"
  | "ocrRecBatch"
  | "ocrBboxCommand"
  | "ocrBboxHintsPath"
>;

export function resolveOcrTranslationOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  settings: AppSettings,
  gemmaVramMode: GemmaVramMode,
): OcrTranslationOptions {
  const ocrGpuBackend = resolveOcrGpuBackend(
    runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_BACKEND,
    settings.ocr.gpuBackend ?? "cuda",
  );
  const ocrDevice = resolveRuntimeOcrDevice(runtimeEnv, settings.ocr.device);
  const configuredQualityMode = resolveOcrQualityMode(
    runtimeEnv.MANGA_TRANSLATOR_OCR_QUALITY_MODE ??
      runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_QUALITY_MODE ??
      runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_PRESET,
    settings.ocr.qualityMode ??
      resolveOcrQualityModeFromGemmaVramMode(gemmaVramMode),
  );
  const ocrQualityMode = resolveRuntimeOcrQualityMode(
    configuredQualityMode,
    ocrDevice,
    ocrGpuBackend,
  );
  return {
    ocrDevice,
    ocrGpuBackend,
    ocrGpuCudaTag: resolveOcrGpuCudaTag(
      runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG ??
        runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG ??
        runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA,
      settings.ocr.gpuCudaTag ?? DEFAULT_OCR_GPU_CUDA_TAG,
    ),
    ocrQualityMode,
    ...resolvePaddleOcrModeOptions(
      runtimeEnv,
      ocrDevice,
      ocrGpuBackend,
      ocrQualityMode,
      resolveOcrSourceLanguage(runtimeEnv, settings),
    ),
    ocrBboxProvider: resolveOptionalString(
      runtimeEnv.MANGA_TRANSLATOR_OCR_BBOX_PROVIDER,
    ),
    ocrBboxCommand: resolveOptionalString(
      runtimeEnv.MANGA_TRANSLATOR_OCR_BBOX_CMD,
    ),
    ocrBboxHintsPath: resolveOptionalString(
      runtimeEnv.MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH,
    ),
  };
}

type PaddleOcrModeOptions = Pick<
  OcrTranslationOptions,
  | "ocrBboxMode"
  | "ocrEngine"
  | "ocrEngineDtype"
  | "ocrVersion"
  | "ocrTextDetectionModelName"
  | "ocrTextRecognitionModelName"
  | "ocrMergeMode"
  | "ocrDetLimit"
  | "ocrRecBatch"
>;

type PaddleOcrModeContext = {
  rocmTransformers: boolean;
  transformersEngine: boolean;
  lowVramModelNames: { det: string; rec: string } | undefined;
  cudaLegacyMode: boolean;
  shouldForceOcrOnly: boolean;
};

const PADDLE_OCR_MODE_ENV_KEYS: Record<keyof PaddleOcrModeOptions, string> = {
  ocrBboxMode: "MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE",
  ocrEngine: "MANGA_TRANSLATOR_PADDLEOCR_ENGINE",
  ocrEngineDtype: "MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE",
  ocrVersion: "MANGA_TRANSLATOR_PADDLEOCR_VERSION",
  ocrTextDetectionModelName:
    "MANGA_TRANSLATOR_PADDLEOCR_TEXT_DETECTION_MODEL_NAME",
  ocrTextRecognitionModelName:
    "MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME",
  ocrMergeMode: "MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE",
  ocrDetLimit: "MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT",
  ocrRecBatch: "MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH",
};

function resolvePaddleOcrModeOptions(
  env: NodeJS.ProcessEnv,
  ocrDevice: OcrDevice,
  ocrGpuBackend: OcrGpuBackend,
  ocrQualityMode: OcrQualityMode,
  sourceLanguage: string,
): PaddleOcrModeOptions {
  const context = resolvePaddleOcrModeContext(
    ocrDevice,
    ocrGpuBackend,
    ocrQualityMode,
    sourceLanguage,
  );
  const defaults = resolvePaddleOcrModeDefaults(context);
  const options: PaddleOcrModeOptions = {};
  for (const key of Object.keys(defaults) as Array<
    keyof PaddleOcrModeOptions
  >) {
    // The quality preset owns the OCR pipeline boundary. In particular, an
    // inherited diagnostic env must never turn CUDA legacy into the common
    // semantic path, or turn a common preset back into the legacy VL path.
    const value = isPresetLockedPipelineMode(key)
      ? defaults[key]
      : (resolveOptionalString(env[PADDLE_OCR_MODE_ENV_KEYS[key]]) ??
        defaults[key]);
    if (value) {
      options[key] = value;
    }
  }
  return options;
}

function resolvePaddleOcrModeContext(
  ocrDevice: OcrDevice,
  ocrGpuBackend: OcrGpuBackend,
  ocrQualityMode: OcrQualityMode,
  sourceLanguage: string,
): PaddleOcrModeContext {
  const rocmTransformers =
    ocrDevice === "gpu" && ocrGpuBackend === "rocm-transformers";
  const lowVramModelNames = resolveLowVramOcrModelNames(
    ocrQualityMode,
    sourceLanguage,
  );
  const semanticFullDefaults = ocrQualityMode === "full";
  return {
    rocmTransformers,
    transformersEngine: rocmTransformers || semanticFullDefaults,
    lowVramModelNames,
    cudaLegacyMode: ocrQualityMode === "cuda-legacy-full" && !rocmTransformers,
    shouldForceOcrOnly:
      Boolean(lowVramModelNames) || rocmTransformers || semanticFullDefaults,
  };
}

function resolvePaddleOcrModeDefaults(
  context: PaddleOcrModeContext,
): Record<keyof PaddleOcrModeOptions, string | undefined> {
  const { transformersEngine, lowVramModelNames, shouldForceOcrOnly } = context;
  const ocrOnlyOrVl = shouldForceOcrOnly || context.cudaLegacyMode;
  return {
    ocrBboxMode: context.cudaLegacyMode ? "vl" : "ocr",
    ocrEngine: transformersEngine
      ? "transformers"
      : shouldForceOcrOnly
        ? "paddle_static"
        : undefined,
    ocrEngineDtype: shouldForceOcrOnly ? "float32" : undefined,
    ocrVersion: ocrOnlyOrVl ? "PP-OCRv6" : undefined,
    ocrTextDetectionModelName: lowVramModelNames?.det,
    ocrTextRecognitionModelName: lowVramModelNames?.rec,
    ocrMergeMode: context.cudaLegacyMode ? "legacy" : "semantic",
    ocrDetLimit: ocrOnlyOrVl ? "1600" : undefined,
    ocrRecBatch: ocrOnlyOrVl ? "1" : undefined,
  };
}

function isPresetLockedPipelineMode(key: keyof PaddleOcrModeOptions): boolean {
  return key === "ocrBboxMode" || key === "ocrMergeMode";
}

function resolveLowVramOcrModelNames(
  ocrQualityMode: OcrQualityMode,
  sourceLanguage: string,
): { det: string; rec: string } | undefined {
  if (ocrQualityMode === "economy") {
    return {
      det: "PP-OCRv6_small_det",
      rec: "PP-OCRv6_small_rec",
    };
  }
  if (ocrQualityMode === "minimum") {
    return {
      det: "PP-OCRv6_small_det",
      // PP-OCRv6 tiny recognition excludes Japanese. Keep the low-memory
      // model for its supported languages, but never select it for the
      // application's default Japanese manga route.
      rec: isJapaneseSourceLanguage(sourceLanguage)
        ? "PP-OCRv6_small_rec"
        : "PP-OCRv6_tiny_rec",
    };
  }
  return undefined;
}

function resolveOcrSourceLanguage(
  runtimeEnv: NodeJS.ProcessEnv,
  settings: AppSettings,
): string {
  return (
    resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_OCR_SOURCE_LANGUAGE) ??
    settings.translation?.sourceLanguage ??
    "ja"
  );
}

function isJapaneseSourceLanguage(sourceLanguage: string): boolean {
  const normalized = sourceLanguage.trim().toLowerCase();
  return normalized === "ja" || normalized.startsWith("ja-");
}

function resolveOcrQualityModeFromGemmaVramMode(
  gemmaVramMode: GemmaVramMode,
): OcrQualityMode {
  if (gemmaVramMode === "full31b") {
    return "full";
  }
  if (gemmaVramMode === "economy26b") {
    return "economy";
  }
  return "minimum";
}

function resolveRuntimeOcrDevice(
  env: NodeJS.ProcessEnv,
  configuredDevice: OcrDevice,
): OcrDevice {
  const explicit =
    env.MANGA_TRANSLATOR_OCR_DEVICE ?? env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE;
  if (explicit !== undefined) {
    return resolveOcrDevice(explicit, configuredDevice);
  }
  return configuredDevice;
}

function resolveRuntimeOcrQualityMode(
  configuredQualityMode: OcrQualityMode,
  ocrDevice: OcrDevice,
  ocrGpuBackend: OcrGpuBackend,
): OcrQualityMode {
  // GPU 전용 고품질 모드는 CPU에서 지나치게 느리므로 절약 품질로 내린다.
  if (
    ocrDevice === "cpu" &&
    (configuredQualityMode === "full" ||
      configuredQualityMode === "cuda-legacy-full")
  ) {
    return "economy";
  }
  // 저장 설정이나 env로 CUDA 레거시 모드가 AMD에 들어오면, 같은 고품질
  // 모델을 쓰는 공통 semantic 풀로드로 안전하게 전환한다.
  if (
    configuredQualityMode === "cuda-legacy-full" &&
    ocrGpuBackend !== "cuda"
  ) {
    return "full";
  }
  return configuredQualityMode;
}
