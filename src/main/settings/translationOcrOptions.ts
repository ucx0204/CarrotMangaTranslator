import { DEFAULT_OCR_GPU_CUDA_TAG } from "../../shared/modelPresets";
import type {
  AppSettings,
  GemmaVramMode,
  LlamaRuntimeProfile,
  OcrDevice,
  OcrGpuBackend,
} from "../../shared/settingsTypes";
import type { TranslationOptions } from "./appSettingsTypes";
import {
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
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
      gemmaVramMode,
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

function resolvePaddleOcrModeOptions(
  env: NodeJS.ProcessEnv,
  ocrDevice: OcrDevice,
  ocrGpuBackend: OcrGpuBackend,
  gemmaVramMode: GemmaVramMode,
): Pick<
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
> {
  const rocmTransformers =
    ocrDevice === "gpu" && ocrGpuBackend === "rocm-transformers";
  const lowVramModelNames = resolveLowVramOcrModelNames(gemmaVramMode);
  const shouldForceOcrOnly = Boolean(lowVramModelNames) || rocmTransformers;

  const options: Pick<
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
  > = {};
  const bboxMode =
    resolveOptionalString(env.MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE) ??
    (shouldForceOcrOnly ? "ocr" : undefined);
  const engine =
    resolveOptionalString(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE) ??
    (rocmTransformers
      ? "transformers"
      : lowVramModelNames
        ? "paddle_static"
        : undefined);
  const dtype =
    resolveOptionalString(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE) ??
    (shouldForceOcrOnly ? "float32" : undefined);
  const ocrVersion =
    resolveOptionalString(env.MANGA_TRANSLATOR_PADDLEOCR_VERSION) ??
    (shouldForceOcrOnly ? "PP-OCRv6" : undefined);
  const textDetectionModelName =
    resolveOptionalString(
      env.MANGA_TRANSLATOR_PADDLEOCR_TEXT_DETECTION_MODEL_NAME,
    ) ?? lowVramModelNames?.det;
  const textRecognitionModelName =
    resolveOptionalString(
      env.MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME,
    ) ?? lowVramModelNames?.rec;
  const mergeMode =
    resolveOptionalString(env.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE) ??
    (shouldForceOcrOnly ? "conservative" : undefined);
  const detLimit =
    resolveOptionalString(env.MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT) ??
    (shouldForceOcrOnly ? "1600" : undefined);
  const recBatch =
    resolveOptionalString(env.MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH) ??
    (shouldForceOcrOnly ? "1" : undefined);
  if (bboxMode) {
    options.ocrBboxMode = bboxMode;
  }
  if (engine) {
    options.ocrEngine = engine;
  }
  if (dtype) {
    options.ocrEngineDtype = dtype;
  }
  if (ocrVersion) {
    options.ocrVersion = ocrVersion;
  }
  if (textDetectionModelName) {
    options.ocrTextDetectionModelName = textDetectionModelName;
  }
  if (textRecognitionModelName) {
    options.ocrTextRecognitionModelName = textRecognitionModelName;
  }
  if (mergeMode) {
    options.ocrMergeMode = mergeMode;
  }
  if (detLimit) {
    options.ocrDetLimit = detLimit;
  }
  if (recBatch) {
    options.ocrRecBatch = recBatch;
  }
  return options;
}

function resolveLowVramOcrModelNames(
  gemmaVramMode: GemmaVramMode,
): { det: string; rec: string } | undefined {
  if (gemmaVramMode === "economy26b") {
    return {
      det: "PP-OCRv6_small_det",
      rec: "PP-OCRv6_small_rec",
    };
  }
  if (gemmaVramMode === "minimum12b") {
    return {
      det: "PP-OCRv6_small_det",
      rec: "PP-OCRv6_tiny_rec",
    };
  }
  return undefined;
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
