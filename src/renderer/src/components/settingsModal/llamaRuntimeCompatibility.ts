import type { LlamaRuntimeProfile } from "../../../../shared/settingsTypes";

export type LlamaRuntimeCompatibilityWarningId =
  | "rtx50-using-cuda12"
  | "non-rtx50-using-rtx50";

export function isRtx50Hardware(
  computeCapability: number | null,
  rtxGeneration: number | null,
): boolean {
  if (computeCapability != null) return computeCapability >= 12;
  return (rtxGeneration ?? 0) >= 50;
}

export function resolveLlamaRuntimeCompatibilityWarning({
  llamaRuntimeProfile,
  usesNvidiaHardware,
  usesRtx50Hardware,
}: {
  llamaRuntimeProfile: LlamaRuntimeProfile;
  usesNvidiaHardware: boolean;
  usesRtx50Hardware: boolean;
}): LlamaRuntimeCompatibilityWarningId | null {
  if (!usesNvidiaHardware) return null;
  if (usesRtx50Hardware && llamaRuntimeProfile === "cuda12") {
    return "rtx50-using-cuda12";
  }
  if (!usesRtx50Hardware && llamaRuntimeProfile === "rtx50") {
    return "non-rtx50-using-rtx50";
  }
  return null;
}
