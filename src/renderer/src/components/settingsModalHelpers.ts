import type { ModelTestProgressEvent } from "../../../shared/jobTypes";
import type {
  AppSettings,
  LlamaRuntimeProfile,
} from "../../../shared/settingsTypes";

export function buildTestDetail(
  modelPath: string | null | undefined,
  mmprojPath: string | null | undefined,
  endpoint: string | null | undefined,
): string | null {
  const lines = [
    modelPath ? `모델: ${modelPath}` : null,
    mmprojPath ? `mmproj: ${mmprojPath}` : null,
    endpoint ? `엔드포인트: ${endpoint}` : null,
  ].filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : null;
}

export function formatModelTestProgressLine(
  event: ModelTestProgressEvent,
): string {
  const percent =
    event.progressMode !== "log-only" &&
    typeof event.progressPercent === "number" &&
    Number.isFinite(event.progressPercent)
      ? `${Math.round(event.progressPercent * 100)}% `
      : "";
  if (event.installLogLine?.trim()) {
    return `${percent}${event.installLogLine.trim()}`;
  }
  const detail = event.detail?.trim();
  return detail
    ? `${percent}${event.progressText} - ${detail}`
    : `${percent}${event.progressText}`;
}

export function resolveHardwareRuntimeLock(
  settings: AppSettings,
): "amd" | "nvidia" | "unknown" {
  const detectedVendor = settings.runtimeHardware?.gpuVendor;
  if (detectedVendor === "amd" || detectedVendor === "nvidia") {
    return detectedVendor;
  }
  if (
    settings.gemma.llamaRocmTarget ||
    isAmdLlamaRuntimeProfile(settings.gemma.llamaRuntimeProfile ?? "cuda12")
  ) {
    return "amd";
  }
  if (
    settings.modelProvider === "gemma" &&
    isNvidiaLlamaRuntimeProfile(settings.gemma.llamaRuntimeProfile ?? "cuda12")
  ) {
    return "nvidia";
  }
  return "unknown";
}

export function isAmdLlamaRuntimeProfile(
  profile: LlamaRuntimeProfile,
): boolean {
  return profile === "rocm" || profile === "vulkan";
}

export function isNvidiaLlamaRuntimeProfile(
  profile: LlamaRuntimeProfile,
): boolean {
  return profile === "cuda12" || profile === "rtx50";
}
