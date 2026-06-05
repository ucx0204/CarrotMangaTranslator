import type { DetectedGpuInfo } from "../gpuInfo";

export type LlamaRuntimeProfile = "cuda12" | "rtx50";

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

export function canonicalizeLlamaRuntimeProfile(value: unknown): LlamaRuntimeProfile | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"].includes(normalized)) {
    return "rtx50";
  }
  if (["cuda12", "cuda12.4"].includes(normalized)) {
    return "cuda12";
  }
  return undefined;
}

export function resolveHardwareLlamaRuntimeProfile(info: DetectedGpuInfo | null): LlamaRuntimeProfile {
  if ((info?.computeCapability ?? 0) >= 12 || (info?.rtxGeneration ?? 0) >= 50) {
    return "rtx50";
  }
  return "cuda12";
}

function resolveOptionalString(value: unknown): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}
