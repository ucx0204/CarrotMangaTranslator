import { DEFAULT_OCR_GPU_CUDA_TAG } from "../../shared/modelPresets";
import type {
  AppSettings,
  GemmaVramMode,
  LlamaRuntimeProfile,
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
import {
  isRocmLlamaRuntimeProfile,
  isVulkanLlamaRuntimeProfile,
} from "./llamaRuntimeProfile";

type OcrTranslationOptions = Pick<
  TranslationOptions,
  | "ocrDevice"
  | "ocrGpuBackend"
  | "ocrGpuCudaTag"
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
  llamaRuntimeProfile: LlamaRuntimeProfile,
  gemmaVramMode: GemmaVramMode,
): OcrTranslationOptions {
  const ocrGpuBackend = resolveOcrGpuBackend(
    runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_BACKEND,
    settings.ocr.gpuBackend ?? "cuda",
  );
  const ocrDevice = resolveRuntimeOcrDevice(
    runtimeEnv,
    settings.ocr.device,
    llamaRuntimeProfile,
    ocrGpuBackend,
  );
  const configuredQualityMode = resolveOcrQualityMode(
    runtimeEnv.MANGA_TRANSLATOR_OCR_QUALITY_MODE ??
      runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_QUALITY_MODE ??
      runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_PRESET,
    settings.ocr.qualityMode ??
      resolveOcrQualityModeFromGemmaVramMode(gemmaVramMode),
  );
  // 풀로드(PaddleOCR-VL) 품질은 CPU에서 못 쓸 만큼 느리므로, 장치가 CPU로
  // 내려간 경로(env 강제, AMD llama 자동 다운그레이드 등)에서는 절약 품질로
  // 실행한다.
  const ocrQualityMode =
    ocrDevice === "cpu" && configuredQualityMode === "full"
      ? "economy"
      : configuredQualityMode;
  return {
    ocrDevice,
    ocrGpuBackend,
    ocrGpuCudaTag: resolveOcrGpuCudaTag(
      runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG ??
        runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG ??
        runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA,
      settings.ocr.gpuCudaTag ?? DEFAULT_OCR_GPU_CUDA_TAG,
    ),
    ...resolvePaddleOcrModeOptions(
      runtimeEnv,
      ocrDevice,
      ocrGpuBackend,
      ocrQualityMode,
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
  lowVramModelNames: { det: string; rec: string } | undefined;
  fullVramVlDefaults: boolean;
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
): PaddleOcrModeOptions {
  const context = resolvePaddleOcrModeContext(
    ocrDevice,
    ocrGpuBackend,
    ocrQualityMode,
  );
  const defaults = resolvePaddleOcrModeDefaults(context);
  const options: PaddleOcrModeOptions = {};
  for (const key of Object.keys(defaults) as Array<
    keyof PaddleOcrModeOptions
  >) {
    const value =
      resolveOptionalString(env[PADDLE_OCR_MODE_ENV_KEYS[key]]) ??
      defaults[key];
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
): PaddleOcrModeContext {
  const rocmTransformers =
    ocrDevice === "gpu" && ocrGpuBackend === "rocm-transformers";
  const lowVramModelNames = resolveLowVramOcrModelNames(ocrQualityMode);
  return {
    rocmTransformers,
    lowVramModelNames,
    fullVramVlDefaults: ocrQualityMode === "full" && !rocmTransformers,
    shouldForceOcrOnly: Boolean(lowVramModelNames) || rocmTransformers,
  };
}

function resolvePaddleOcrModeDefaults(
  context: PaddleOcrModeContext,
): Record<keyof PaddleOcrModeOptions, string | undefined> {
  const { rocmTransformers, lowVramModelNames, shouldForceOcrOnly } = context;
  const ocrOnlyOrVl = shouldForceOcrOnly || context.fullVramVlDefaults;
  return {
    ocrBboxMode: forcedOrVlDefault(context, "ocr", "vl"),
    ocrEngine: rocmTransformers
      ? "transformers"
      : lowVramModelNames
        ? "paddle_static"
        : undefined,
    ocrEngineDtype: shouldForceOcrOnly ? "float32" : undefined,
    ocrVersion: ocrOnlyOrVl ? "PP-OCRv6" : undefined,
    ocrTextDetectionModelName: lowVramModelNames?.det,
    ocrTextRecognitionModelName: lowVramModelNames?.rec,
    ocrMergeMode: forcedOrVlDefault(context, "conservative", "legacy"),
    ocrDetLimit: ocrOnlyOrVl ? "1600" : undefined,
    ocrRecBatch: ocrOnlyOrVl ? "1" : undefined,
  };
}

function forcedOrVlDefault(
  context: PaddleOcrModeContext,
  forcedValue: string,
  vlValue: string,
): string | undefined {
  if (context.shouldForceOcrOnly) {
    return forcedValue;
  }
  if (context.fullVramVlDefaults) {
    return vlValue;
  }
  return undefined;
}

function resolveLowVramOcrModelNames(
  ocrQualityMode: OcrQualityMode,
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
      rec: "PP-OCRv6_tiny_rec",
    };
  }
  return undefined;
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
  llamaRuntimeProfile: LlamaRuntimeProfile,
  ocrGpuBackend: OcrGpuBackend,
): OcrDevice {
  const explicit =
    env.MANGA_TRANSLATOR_OCR_DEVICE ?? env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE;
  if (explicit !== undefined) {
    return resolveOcrDevice(explicit, configuredDevice);
  }
  if (isAmdLlamaWithoutTransformersOcr(llamaRuntimeProfile, ocrGpuBackend)) {
    return "cpu";
  }
  return configuredDevice;
}

function isAmdLlamaWithoutTransformersOcr(
  llamaRuntimeProfile: LlamaRuntimeProfile,
  ocrGpuBackend: OcrGpuBackend,
): boolean {
  return (
    (isRocmLlamaRuntimeProfile(llamaRuntimeProfile) ||
      isVulkanLlamaRuntimeProfile(llamaRuntimeProfile)) &&
    ocrGpuBackend !== "rocm-transformers"
  );
}
