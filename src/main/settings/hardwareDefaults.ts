import {
  DEFAULT_OCR_GPU_CUDA_TAG,
  RTX_50_OCR_GPU_CUDA_TAG,
} from "../../shared/modelPresets";
import type {
  AmdRocmTarget,
  FluxBackend,
  GemmaVramMode,
  LlamaRuntimeProfile,
  ModelProvider,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
} from "../../shared/settingsTypes";
import type { DetectedGpuInfo } from "../gpuInfo";
import { isFluxRtx20Sm75Hardware } from "../../shared/fluxSm75";
import {
  normalizeAmdRocmTarget,
  resolveAmdRocmTargetFromInfo,
} from "../gpuInfo";
import { resolveHardwareLlamaRuntimeProfile } from "./llamaRuntimeProfile";
import { supportsWindowsRocmOcrGpu } from "./ocrRocmSupport";

const GEMMA_MINIMUM_VRAM_MB = 8000;
const GEMMA_ECONOMY_VRAM_MB = 16000;
const GEMMA_FULL_VRAM_MB = 24000;
const GEMMA_APPLE_MINIMUM_UNIFIED_MEMORY_MB = 16 * 1024;
const GEMMA_APPLE_ECONOMY_UNIFIED_MEMORY_MB = 24 * 1024;
const GEMMA_APPLE_FULL_UNIFIED_MEMORY_MB = 32 * 1024;
const GEMMA_MINIMUM_COMPUTE_CAPABILITY = 7.5;
const GEMMA_MINIMUM_RTX_GENERATION = 20;

export type HardwareDefaults = {
  modelProvider: ModelProvider;
  gemmaVramMode: GemmaVramMode;
  ocrDevice: OcrDevice;
  ocrQualityMode: OcrQualityMode;
  ocrGpuCudaTag: string;
  ocrGpuBackend: OcrGpuBackend;
  llamaRuntimeProfile: LlamaRuntimeProfile;
  llamaRocmTarget?: AmdRocmTarget;
  fluxBackend: FluxBackend;
};

type HardwareBaseDefaults = Omit<
  HardwareDefaults,
  "gemmaVramMode" | "modelProvider" | "ocrDevice" | "ocrQualityMode"
>;

export function resolveHardwareDefaults(
  detectedGpu?: number | DetectedGpuInfo | null,
): HardwareDefaults {
  const info = normalizeDetectedGpuInfo(detectedGpu);
  const baseDefaults = resolveHardwareBaseDefaults(info);
  if (!supportsGemmaDefaults(info)) {
    return buildHardwareDefaults(
      baseDefaults,
      "openai-codex",
      "minimum12b",
      "cpu",
    );
  }

  return buildHardwareDefaults(
    baseDefaults,
    "gemma",
    resolveGemmaDefaultVramMode(info),
    resolveHardwareOcrDevice(info, baseDefaults.ocrGpuBackend),
  );
}

function supportsGemmaDefaults(info: DetectedGpuInfo | null): boolean {
  return (
    hasMinimumGemmaVram(info) &&
    (supportsNvidiaGpuDefaults(info) ||
      supportsAmdGpuDefaults(info) ||
      supportsAppleGpuDefaults(info))
  );
}

function hasMinimumGemmaVram(info: DetectedGpuInfo | null): boolean {
  if (info?.vendor === "apple") {
    return (
      resolveUnifiedMemoryMb(info) >= GEMMA_APPLE_MINIMUM_UNIFIED_MEMORY_MB
    );
  }
  return (info?.memoryMb ?? 0) >= GEMMA_MINIMUM_VRAM_MB;
}

function supportsNvidiaGpuDefaults(info: DetectedGpuInfo | null): boolean {
  if (info?.vendor === "amd" || info?.vendor === "apple") {
    return false;
  }
  return (
    supportsMinimumRtxGeneration(info) || supportsMinimumComputeCapability(info)
  );
}

function supportsAppleGpuDefaults(info: DetectedGpuInfo | null): boolean {
  return info?.vendor === "apple" && info.supportsMetal === true;
}

function supportsAmdGpuDefaults(info: DetectedGpuInfo | null): boolean {
  return (
    info?.vendor === "amd" && Boolean(info.supportsVulkan || info.supportsRocm)
  );
}

function supportsMinimumRtxGeneration(info: DetectedGpuInfo | null): boolean {
  return (info?.rtxGeneration ?? 0) >= GEMMA_MINIMUM_RTX_GENERATION;
}

function supportsMinimumComputeCapability(
  info: DetectedGpuInfo | null,
): boolean {
  return (info?.computeCapability ?? 0) >= GEMMA_MINIMUM_COMPUTE_CAPABILITY;
}

function resolveHardwareOcrDevice(
  info: DetectedGpuInfo | null,
  ocrGpuBackend: OcrGpuBackend,
): OcrDevice {
  if (!hasMinimumGemmaVram(info)) {
    return "cpu";
  }
  return supportsHardwareOcrGpu(info, ocrGpuBackend) ? "gpu" : "cpu";
}

function supportsHardwareOcrGpu(
  info: DetectedGpuInfo | null,
  ocrGpuBackend: OcrGpuBackend,
): boolean {
  return (
    (info?.vendor !== "apple" && supportsNvidiaGpuDefaults(info)) ||
    ocrGpuBackend === "rocm-transformers"
  );
}

function resolveGemmaDefaultVramMode(
  info: DetectedGpuInfo | null,
): GemmaVramMode {
  const memoryMb =
    info?.vendor === "apple"
      ? resolveUnifiedMemoryMb(info)
      : (info?.memoryMb ?? 0);
  if (info?.vendor === "apple") {
    if (memoryMb >= GEMMA_APPLE_FULL_UNIFIED_MEMORY_MB) {
      return "full31b";
    }
    if (memoryMb >= GEMMA_APPLE_ECONOMY_UNIFIED_MEMORY_MB) {
      return "economy26b";
    }
    return "minimum12b";
  }
  if (memoryMb >= GEMMA_FULL_VRAM_MB) {
    return "full31b";
  }
  if (memoryMb >= GEMMA_ECONOMY_VRAM_MB) {
    return "economy26b";
  }
  return "minimum12b";
}

function resolveHardwareBaseDefaults(
  info: DetectedGpuInfo | null,
): HardwareBaseDefaults {
  const llamaRocmTarget = resolveHardwareLlamaRocmTarget(info);
  return {
    ocrGpuCudaTag: resolveHardwareOcrGpuCudaTag(info),
    ocrGpuBackend: resolveHardwareOcrGpuBackend(info),
    llamaRuntimeProfile: resolveHardwareLlamaRuntimeProfile(info),
    ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
    fluxBackend: resolveHardwareFluxBackend(info),
  };
}

function buildHardwareDefaults(
  baseDefaults: HardwareBaseDefaults,
  modelProvider: ModelProvider,
  gemmaVramMode: GemmaVramMode,
  ocrDevice: OcrDevice,
): HardwareDefaults {
  return {
    modelProvider,
    gemmaVramMode,
    ocrDevice,
    ocrQualityMode: resolveHardwareOcrQualityMode(gemmaVramMode, ocrDevice),
    ...baseDefaults,
  };
}

function resolveHardwareOcrQualityMode(
  gemmaVramMode: GemmaVramMode,
  ocrDevice: OcrDevice,
): OcrQualityMode {
  if (gemmaVramMode === "full31b") {
    // 풀로드 품질은 CPU에서 못 쓸 만큼 느리다.
    return ocrDevice === "gpu" ? "full" : "economy";
  }
  if (gemmaVramMode === "economy26b") {
    return "economy";
  }
  return "minimum";
}

function resolveHardwareOcrGpuCudaTag(info: DetectedGpuInfo | null): string {
  if (info?.vendor === "amd") {
    return DEFAULT_OCR_GPU_CUDA_TAG;
  }
  if (
    (info?.computeCapability ?? 0) >= 12 ||
    (info?.rtxGeneration ?? 0) >= 50
  ) {
    return RTX_50_OCR_GPU_CUDA_TAG;
  }
  return DEFAULT_OCR_GPU_CUDA_TAG;
}

function resolveHardwareOcrGpuBackend(
  info: DetectedGpuInfo | null,
): OcrGpuBackend {
  // Only GPUs Windows PyTorch ROCm actually supports get the ROCm OCR
  // backend. Other AMD cards default to CPU OCR with the CUDA backend kept as
  // metadata; an explicit later GPU selection is preserved and fails loudly
  // if that backend cannot run.
  if (info?.vendor === "amd" && supportsWindowsRocmOcrGpu(info)) {
    return "rocm-transformers";
  }
  return "cuda";
}

function resolveHardwareLlamaRocmTarget(
  info: DetectedGpuInfo | null,
): AmdRocmTarget | undefined {
  if (info?.vendor !== "amd") {
    return undefined;
  }
  return resolveAmdRocmTargetFromInfo(info) ?? undefined;
}

function resolveHardwareFluxBackend(info: DetectedGpuInfo | null): FluxBackend {
  if (info?.vendor === "apple") {
    return "metal-native";
  }
  if (info?.vendor !== "amd") {
    return isFluxRtx20Sm75Hardware({
      computeCapability: info?.computeCapability,
      rtxGeneration: info?.rtxGeneration,
    })
      ? "cuda-sm75-experimental"
      : "cuda-native";
  }
  return "zluda-native";
}

function normalizeDetectedGpuInfo(
  value?: number | DetectedGpuInfo | null,
): DetectedGpuInfo | null {
  if (typeof value === "number") {
    return normalizeDetectedGpuMemory(value);
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  return normalizeDetectedGpuObject(value);
}

function normalizeDetectedGpuMemory(memoryMb: number): DetectedGpuInfo | null {
  if (!Number.isFinite(memoryMb) || memoryMb <= 0) {
    return null;
  }
  return {
    name: null,
    memoryMb,
    rtxGeneration: null,
    computeCapability: null,
    vendor: "unknown",
  };
}

function normalizeDetectedGpuObject(value: DetectedGpuInfo): DetectedGpuInfo {
  const normalized: DetectedGpuInfo = {
    name: typeof value.name === "string" ? value.name : null,
    memoryMb: normalizeFiniteNumber(value.memoryMb),
    rtxGeneration: normalizeFiniteNumber(value.rtxGeneration),
    computeCapability: normalizeFiniteNumber(value.computeCapability),
    vendor: normalizeGpuVendor(value.vendor),
    rocmArch: typeof value.rocmArch === "string" ? value.rocmArch : null,
    rocmTarget: normalizeAmdRocmTarget(value.rocmTarget),
    supportsRocm: normalizeBoolean(value.supportsRocm),
    supportsVulkan: normalizeBoolean(
      value.supportsVulkan,
      value.vendor === "amd",
    ),
    supportsMetal: normalizeBoolean(
      value.supportsMetal,
      value.vendor === "apple",
    ),
    unifiedMemoryMb: normalizeFiniteNumber(value.unifiedMemoryMb),
  };
  const inferredRocmTarget = resolveAmdRocmTargetFromInfo(normalized);
  return {
    ...normalized,
    rocmTarget: inferredRocmTarget,
    supportsRocm: normalized.supportsRocm || Boolean(inferredRocmTarget),
  };
}

function normalizeFiniteNumber(
  value: number | null | undefined,
): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeGpuVendor(
  vendor: DetectedGpuInfo["vendor"],
): NonNullable<DetectedGpuInfo["vendor"]> {
  return vendor === "nvidia" || vendor === "amd" || vendor === "apple"
    ? vendor
    : "unknown";
}

function resolveUnifiedMemoryMb(info: DetectedGpuInfo): number {
  return info.unifiedMemoryMb ?? info.memoryMb ?? 0;
}

function normalizeBoolean(
  value: boolean | undefined,
  fallback = false,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}
