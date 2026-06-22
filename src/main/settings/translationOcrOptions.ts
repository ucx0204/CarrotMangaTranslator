import { DEFAULT_OCR_GPU_CUDA_TAG } from "../../shared/modelPresets";
import type {
  AppSettings,
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
  | "ocrBboxCommand"
  | "ocrBboxHintsPath"
>;

export function resolveOcrTranslationOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  settings: AppSettings,
  llamaRuntimeProfile: LlamaRuntimeProfile,
): OcrTranslationOptions {
  const ocrGpuBackend = resolveOcrGpuBackend(
    runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_BACKEND,
    settings.ocr.gpuBackend ?? "cuda",
  );
  return {
    ocrDevice: resolveRuntimeOcrDevice(
      runtimeEnv,
      settings.ocr.device,
      llamaRuntimeProfile,
      ocrGpuBackend,
    ),
    ocrGpuBackend,
    ocrGpuCudaTag: resolveOcrGpuCudaTag(
      runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG ??
        runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG ??
        runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA,
      settings.ocr.gpuCudaTag ?? DEFAULT_OCR_GPU_CUDA_TAG,
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
