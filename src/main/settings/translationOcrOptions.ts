import { DEFAULT_OCR_GPU_CUDA_TAG } from "../../shared/modelPresets";
import type {
  AppSettings,
  GemmaVramMode,
  OcrDevice,
  OcrGpuBackend,
  OcrPipeline,
  OcrQualityMode,
} from "../../shared/settingsTypes";
import { resolveOcrBboxProvider } from "../../shared/ocrEngines";
import type { TranslationOptions } from "./appSettingsTypes";
import {
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOcrPipeline,
  resolveOcrQualityMode,
  resolveOptionalString,
} from "./appSettingsResolvers";
type OcrTranslationOptions = Pick<
  TranslationOptions,
  | "ocrDevice"
  | "ocrPipeline"
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
  | "ocrBboxRegionsPath"
>;

export function resolveOcrTranslationOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  settings: AppSettings,
  gemmaVramMode: GemmaVramMode,
): OcrTranslationOptions {
  const ocrPipeline = resolveOcrPipeline(
    runtimeEnv.MANGA_TRANSLATOR_OCR_PIPELINE,
    settings.ocr.pipeline ?? "paddle-legacy",
  );
  const configuredOcrGpuBackend = resolveOcrGpuBackend(
    runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_BACKEND,
    settings.ocr.gpuBackend ?? "cuda",
  );
  const ocrDevice = resolveRuntimeOcrDevice(
    runtimeEnv,
    settings.ocr.device,
    ocrPipeline,
  );
  const ocrGpuBackend = configuredOcrGpuBackend;
  const configuredQualityMode = resolveOcrQualityMode(
    runtimeEnv.MANGA_TRANSLATOR_OCR_QUALITY_MODE ??
      (ocrPipeline === "paddle-legacy"
        ? (runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_QUALITY_MODE ??
          runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_PRESET)
        : undefined),
    settings.ocr.qualityMode ??
      resolveOcrQualityModeFromGemmaVramMode(gemmaVramMode),
  );
  const ocrQualityMode = resolveRuntimeOcrQualityMode(
    configuredQualityMode,
    ocrDevice,
  );
  // Pipeline, provider, and device form one explicit runtime profile. The
  // provider is derived from the selected pipeline so an inherited diagnostic
  // environment cannot cross the Hayai/Paddle engine boundary.
  return {
    ocrPipeline,
    ocrDevice,
    ocrGpuBackend,
    ocrGpuCudaTag: resolveOcrGpuCudaTag(
      runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG ??
        (ocrPipeline === "paddle-legacy"
          ? runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG
          : undefined) ??
        runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA,
      settings.ocr.gpuCudaTag ?? DEFAULT_OCR_GPU_CUDA_TAG,
    ),
    ocrQualityMode,
    ...(ocrPipeline === "paddle-legacy"
      ? resolvePaddleOcrModeOptions(
          runtimeEnv,
          ocrDevice,
          ocrGpuBackend,
          ocrQualityMode,
        )
      : {}),
    ocrBboxProvider: resolveOcrBboxProvider(ocrPipeline),
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
    // The quality preset owns the OCR pipeline boundary. An inherited
    // diagnostic environment must not replace the supported OCR/semantic
    // route with a different bounding-box or merge implementation.
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
): PaddleOcrModeContext {
  const rocmTransformers =
    ocrDevice === "gpu" && ocrGpuBackend === "rocm-transformers";
  const lowVramModelNames = resolveLowVramOcrModelNames(ocrQualityMode);
  const semanticFullDefaults = ocrQualityMode === "full";
  return {
    rocmTransformers,
    transformersEngine: rocmTransformers || semanticFullDefaults,
    lowVramModelNames,
    shouldForceOcrOnly:
      Boolean(lowVramModelNames) || rocmTransformers || semanticFullDefaults,
  };
}

function resolvePaddleOcrModeDefaults(
  context: PaddleOcrModeContext,
): Record<keyof PaddleOcrModeOptions, string | undefined> {
  const { transformersEngine, lowVramModelNames, shouldForceOcrOnly } = context;
  return {
    ocrBboxMode: "ocr",
    ocrEngine: transformersEngine
      ? "transformers"
      : shouldForceOcrOnly
        ? "paddle_static"
        : undefined,
    ocrEngineDtype: shouldForceOcrOnly ? "float32" : undefined,
    ocrVersion: shouldForceOcrOnly ? "PP-OCRv6" : undefined,
    ocrTextDetectionModelName: lowVramModelNames?.det,
    ocrTextRecognitionModelName: lowVramModelNames?.rec,
    ocrMergeMode: "semantic",
    ocrDetLimit: shouldForceOcrOnly ? "1600" : undefined,
    ocrRecBatch: shouldForceOcrOnly ? "1" : undefined,
  };
}

function isPresetLockedPipelineMode(key: keyof PaddleOcrModeOptions): boolean {
  return key === "ocrBboxMode" || key === "ocrMergeMode";
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
  return undefined;
}

function resolveOcrQualityModeFromGemmaVramMode(
  gemmaVramMode: GemmaVramMode,
): OcrQualityMode {
  if (gemmaVramMode === "full31b") {
    return "full";
  }
  return "economy";
}

function resolveRuntimeOcrDevice(
  env: NodeJS.ProcessEnv,
  configuredDevice: OcrDevice,
  pipeline: OcrPipeline,
): OcrDevice {
  const explicit =
    env.MANGA_TRANSLATOR_OCR_DEVICE ??
    (pipeline === "paddle-legacy"
      ? env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE
      : undefined);
  if (explicit !== undefined) {
    return resolveOcrDevice(explicit, configuredDevice);
  }
  return configuredDevice;
}

function resolveRuntimeOcrQualityMode(
  configuredQualityMode: OcrQualityMode,
  ocrDevice: OcrDevice,
): OcrQualityMode {
  // GPU 전용 고품질 모드는 CPU에서 지나치게 느리므로 절약 품질로 내린다.
  if (ocrDevice === "cpu" && configuredQualityMode === "full") {
    return "economy";
  }
  return configuredQualityMode;
}
