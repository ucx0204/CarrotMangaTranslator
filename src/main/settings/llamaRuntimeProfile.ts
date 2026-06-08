import type { DetectedGpuInfo } from "../gpuInfo";
import type { LlamaRuntimeProfile } from "../../shared/types";

export function resolveLlamaRuntimeProfile(
  env: { MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE?: string },
  fallback: unknown = "cuda12"
): LlamaRuntimeProfile {
  const explicit = resolveOptionalString(env.MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE);
  if (explicit) {
    return canonicalizeLlamaRuntimeProfile(explicit) ?? canonicalizeLlamaRuntimeProfile(fallback) ?? "cuda12";
  }
  return canonicalizeLlamaRuntimeProfile(fallback) ?? "cuda12";
}

export function isRtx50LlamaRuntimeProfile(profile: string): boolean {
  return canonicalizeLlamaRuntimeProfile(profile) === "rtx50";
}

export function isRocmLlamaRuntimeProfile(profile: string): boolean {
  return canonicalizeLlamaRuntimeProfile(profile) === "rocm";
}

export function isVulkanLlamaRuntimeProfile(profile: string): boolean {
  return canonicalizeLlamaRuntimeProfile(profile) === "vulkan";
}

export function canonicalizeLlamaRuntimeProfile(value: unknown): LlamaRuntimeProfile | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"].includes(normalized)) {
    return "rtx50";
  }
  if (["cuda12", "cuda12.4", "cuda"].includes(normalized)) {
    return "cuda12";
  }
  if (["rocm", "hip", "amd-rocm"].includes(normalized)) {
    return "rocm";
  }
  if (["vulkan", "vk", "amd-vulkan"].includes(normalized)) {
    return "vulkan";
  }
  return undefined;
}

export function resolveHardwareLlamaRuntimeProfile(info: DetectedGpuInfo | null): LlamaRuntimeProfile {
  if (info?.vendor === "amd") {
    return "vulkan";
  }
  if ((info?.computeCapability ?? 0) >= 12) {
    return "rtx50";
  }
  if (info?.computeCapability == null && (info?.rtxGeneration ?? 0) >= 50) {
    return "rtx50";
  }
  return "cuda12";
}

function resolveOptionalString(value: unknown): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}
