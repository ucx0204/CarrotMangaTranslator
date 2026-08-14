import type { OcrDevice, OcrGpuBackend } from "../../shared/settingsTypes";
import { resolveOcrDevice, resolveOcrGpuBackend } from "./appSettingsResolvers";

export type OcrNormalizationPolicy = {
  allowUnsupportedAmdOcrGpu?: boolean;
  /**
   * Authoritative detector result. `unknown` means detection completed without
   * a classified adapter; omission preserves the legacy defaults fallback.
   */
  detectedHardwareVendor?: "amd" | "nvidia" | "apple" | "unknown";
  detectedAmdOcrRocmSupport?: boolean;
};

/**
 * Return true only for a recognized, explicit environment override that can
 * opt into GPU OCR. Invalid values must not turn off hardware safety guards.
 */
export function hasExplicitOcrGpuEnableOverride(
  env: NodeJS.ProcessEnv,
): boolean {
  const deviceValue =
    env.MANGA_TRANSLATOR_OCR_DEVICE ?? env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE;
  return (
    resolvesToSameOcrDevice(deviceValue, "gpu") ||
    resolvesToSameOcrBackend(env.MANGA_TRANSLATOR_OCR_GPU_BACKEND)
  );
}

function resolvesToSameOcrDevice(value: unknown, expected: OcrDevice): boolean {
  if (value === undefined) return false;
  return (
    resolveOcrDevice(value, "cpu") === expected &&
    resolveOcrDevice(value, "gpu") === expected
  );
}

function resolvesToSameOcrBackend(value: unknown): boolean {
  if (value === undefined) return false;
  const resolvedWithCuda = resolveOcrGpuBackend(value, "cuda");
  const resolvedWithRocm = resolveOcrGpuBackend(value, "rocm-transformers");
  return (
    resolvedWithCuda === resolvedWithRocm && isOcrGpuBackend(resolvedWithCuda)
  );
}

function isOcrGpuBackend(value: string): value is OcrGpuBackend {
  return value === "cuda" || value === "rocm-transformers";
}
