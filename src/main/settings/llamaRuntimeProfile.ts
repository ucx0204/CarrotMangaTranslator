import type { DetectedGpuInfo } from "../gpuInfo";
import { resolveAmdRocmTargetFromInfo } from "../gpuInfo";
import type { LlamaRuntimeProfile } from "../../shared/settingsTypes";
import { canonicalizeLlamaRuntimeProfile } from "../../shared/settingsAliasCanonicalizers";

export function resolveLlamaRuntimeProfile(
  env: { MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE?: string },
  fallback: unknown = "cuda12",
): LlamaRuntimeProfile {
  const explicit = resolveOptionalString(
    env.MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE,
  );
  if (explicit) {
    return (
      canonicalizeLlamaRuntimeProfile(explicit) ??
      canonicalizeLlamaRuntimeProfile(fallback) ??
      "cuda12"
    );
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

export function isMetalLlamaRuntimeProfile(profile: string): boolean {
  return canonicalizeLlamaRuntimeProfile(profile) === "metal";
}

export function isAmdLlamaRuntimeProfile(profile: string): boolean {
  const canonical = canonicalizeLlamaRuntimeProfile(profile);
  return canonical === "rocm" || canonical === "vulkan";
}

export function isNvidiaLlamaRuntimeProfile(profile: string): boolean {
  const canonical = canonicalizeLlamaRuntimeProfile(profile);
  return canonical === "cuda12" || canonical === "rtx50";
}

export function resolveHardwareLlamaRuntimeProfile(
  info: DetectedGpuInfo | null,
): LlamaRuntimeProfile {
  if (info?.vendor === "apple") {
    return "metal";
  }
  return resolveNonAppleHardwareLlamaRuntimeProfile(info);
}

function resolveNonAppleHardwareLlamaRuntimeProfile(
  info: DetectedGpuInfo | null,
): LlamaRuntimeProfile {
  if (info?.vendor === "amd") {
    return resolveAmdRocmTargetFromInfo(info) ? "rocm" : "vulkan";
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
