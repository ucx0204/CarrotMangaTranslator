import type { OcrDevice, OcrQualityMode } from "./settingsTypes";

/**
 * PP-OCRv6 medium det+rec peaked at 0.91 GiB of reserved CUDA memory in the
 * production Transformers pipeline (1600px detection limit, recognition batch
 * size 1). Four GiB leaves practical room for the display driver and allocator
 * fragmentation without tying OCR quality to the much larger Gemma budget.
 */
export const OCR_FULL_RECOMMENDED_GPU_MEMORY_MB = 4 * 1024;

export function resolveRecommendedOcrQualityMode(options: {
  ocrDevice: OcrDevice;
  gpuMemoryMb?: number | null;
}): OcrQualityMode {
  if (options.ocrDevice !== "gpu") return "economy";
  return (options.gpuMemoryMb ?? 0) >= OCR_FULL_RECOMMENDED_GPU_MEMORY_MB
    ? "full"
    : "economy";
}
