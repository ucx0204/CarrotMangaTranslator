import type { ModelTestProgressEvent } from "../../../shared/jobTypes";
import type { TFunction } from "i18next";
import type {
  AppSettings,
  LlamaRuntimeProfile,
} from "../../../shared/settingsTypes";
import { formatErrorMessage } from "../lib/errorPresentation";

export function formatSettingsErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return formatErrorMessage(error, fallback);
}

export function buildTestDetail(
  modelPath: string | null | undefined,
  mmprojPath: string | null | undefined,
  endpoint: string | null | undefined,
  t: TFunction<"components">,
): string | null {
  const lines = [
    modelPath ? t("settings.test.detail.model", { path: modelPath }) : null,
    mmprojPath ? t("settings.test.detail.mmproj", { path: mmprojPath }) : null,
    endpoint ? t("settings.test.detail.endpoint", { endpoint }) : null,
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
): "amd" | "nvidia" | "apple" | "unknown" {
  const detectedVendor = recognizedGpuVendor(
    settings.runtimeHardware?.gpuVendor,
  );
  if (detectedVendor !== "unknown") {
    return detectedVendor;
  }
  if (settings.gemma.llamaRocmTarget) {
    return "amd";
  }
  return inferGpuVendorFromLlamaProfile(
    settings.gemma.llamaRuntimeProfile ?? "cuda12",
    settings.modelProvider === "gemma",
  );
}

function recognizedGpuVendor(
  vendor: NonNullable<AppSettings["runtimeHardware"]>["gpuVendor"] | undefined,
): "amd" | "nvidia" | "apple" | "unknown" {
  return vendor === "amd" || vendor === "nvidia" || vendor === "apple"
    ? vendor
    : "unknown";
}

function inferGpuVendorFromLlamaProfile(
  profile: LlamaRuntimeProfile,
  gemmaSelected: boolean,
): "amd" | "nvidia" | "apple" | "unknown" {
  if (isAppleLlamaRuntimeProfile(profile)) return "apple";
  if (isAmdLlamaRuntimeProfile(profile)) return "amd";
  return gemmaSelected && isNvidiaLlamaRuntimeProfile(profile)
    ? "nvidia"
    : "unknown";
}

export function isAppleLlamaRuntimeProfile(
  profile: LlamaRuntimeProfile,
): boolean {
  return profile === "metal";
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
