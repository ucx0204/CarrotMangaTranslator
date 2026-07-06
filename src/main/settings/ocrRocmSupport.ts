import { parseRocmArch } from "../amdRocmTargets";
import type { DetectedGpuInfo } from "../gpuInfo";

/**
 * Windows PyTorch ROCm 7.2.1 (the OCR rocm-transformers runtime) officially
 * supports only these architectures. Other AMD GPUs that merely have a llama
 * `rocmTarget` (RX 6000 = gfx103X, RX 7600 = gfx1102, Radeon 7x0M iGPUs =
 * gfx1103, ...) crash or hang the HIP runtime on Windows, so OCR defaults to
 * CPU for them. Power users can still force GPU via
 * MANGA_TRANSLATOR_OCR_GPU_BACKEND / MANGA_TRANSLATOR_OCR_DEVICE.
 */
const SUPPORTED_WINDOWS_ROCM_OCR_ARCHES = new Set([
  "gfx1100",
  "gfx1101",
  "gfx1200",
  "gfx1201",
]);

const SUPPORTED_WINDOWS_ROCM_OCR_NAME_PATTERNS: RegExp[] = [
  // gfx1100/gfx1101 discrete cards. RX 7600/7650 (gfx1102) and Radeon
  // 740M/760M/780M (gfx1103) are intentionally absent. The trailing \b keeps
  // mobile gfx1102 parts like "RX 7700S" from matching.
  /\b(rx\s*)?7(700|800|900)(\s*(xt|xtx|gre|m))?\b/,
  /\b(?:radeon\s+)?(?:pro\s*)?w7(700|800|900)\b/,
  /\b(?:amd\s+)?(?:radeon\s+)?(?:pro\s+)?v\s*710(?:\s*mxgpu)?(?:[-\s]\d+q)?\b/,
  /\bven_1002&dev_746[01]\b/,
  // gfx1200/gfx1201 (RX 9000 / AI PRO R9700).
  /\b(rx\s*)?90(60|70)(\s*(xt|gre))?\b/,
  /\b(?:amd\s+)?(?:radeon\s+)?(?:ai\s+)?pro\s+r\s*9700\b/,
];

export function supportsWindowsRocmOcrGpu(
  info: DetectedGpuInfo | null,
): boolean {
  if (!info || info.vendor !== "amd") {
    return false;
  }
  const arch = parseRocmArch(String(info.rocmArch ?? ""));
  if (arch) {
    const baseArch = arch.match(/^gfx[0-9a-f]+/)?.[0] ?? arch;
    return SUPPORTED_WINDOWS_ROCM_OCR_ARCHES.has(baseArch);
  }
  const name = String(info.name ?? "")
    .toLowerCase()
    .replace(/[™®]/g, " ");
  if (!name.trim()) {
    return false;
  }
  return SUPPORTED_WINDOWS_ROCM_OCR_NAME_PATTERNS.some((pattern) =>
    pattern.test(name),
  );
}
