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
} from "../../shared/types";
import type { DetectedGpuInfo } from "../gpuInfo";
import {
  normalizeAmdRocmTarget,
  resolveAmdRocmTargetFromInfo,
} from "../gpuInfo";
import { resolveHardwareLlamaRuntimeProfile } from "./llamaRuntimeProfile";

const GEMMA_MINIMUM_VRAM_MB = 8000;
const GEMMA_ECONOMY_VRAM_MB = 16000;
const GEMMA_FULL_VRAM_MB = 24000;
const GEMMA_MINIMUM_COMPUTE_CAPABILITY = 7.5;
const GEMMA_MINIMUM_RTX_GENERATION = 20;

export type HardwareDefaults = {
  modelProvider: ModelProvider;
  gemmaVramMode: GemmaVramMode;
  ocrDevice: OcrDevice;
  ocrGpuCudaTag: string;
  ocrGpuBackend: OcrGpuBackend;
  llamaRuntimeProfile: LlamaRuntimeProfile;
  llamaRocmTarget?: AmdRocmTarget;
  fluxBackend: FluxBackend;
};

type HardwareBaseDefaults = Omit<
  HardwareDefaults,
  "gemmaVramMode" | "modelProvider" | "ocrDevice"
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
    resolveGemmaDefaultVramMode(info?.memoryMb ?? 0),
    resolveHardwareOcrDevice(info, baseDefaults.ocrGpuBackend),
  );
}

function supportsGemmaDefaults(info: DetectedGpuInfo | null): boolean {
  return (
    hasMinimumGemmaVram(info) &&
    (supportsNvidiaGpuDefaults(info) || supportsAmdGpuDefaults(info))
  );
}

function hasMinimumGemmaVram(info: DetectedGpuInfo | null): boolean {
  return (info?.memoryMb ?? 0) >= GEMMA_MINIMUM_VRAM_MB;
}

function supportsNvidiaGpuDefaults(info: DetectedGpuInfo | null): boolean {
  if (info?.vendor === "amd") {
    return false;
  }
  return (
    supportsMinimumRtxGeneration(info) || supportsMinimumComputeCapability(info)
  );
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
    supportsNvidiaGpuDefaults(info) || ocrGpuBackend === "rocm-transformers"
  );
}

function resolveGemmaDefaultVramMode(memoryMb: number): GemmaVramMode {
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
    ...baseDefaults,
  };
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
  if (info?.vendor === "amd" && (info.supportsRocm || info.rocmTarget)) {
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
  if (info?.vendor !== "amd") {
    return "cuda-native";
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
  return vendor === "nvidia" || vendor === "amd" ? vendor : "unknown";
}

function normalizeBoolean(
  value: boolean | undefined,
  fallback = false,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}
