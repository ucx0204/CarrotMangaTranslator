import type { AppSettings } from "../../shared/settingsTypes";
import {
  normalizeComputeGpuIndex,
  normalizeGraphicsGpuPreference,
} from "../../shared/gpuSettings";

export function normalizeHardwareGpuSettings(
  hardware: Record<string, unknown> | null,
  defaults: AppSettings,
): NonNullable<AppSettings["hardware"]> {
  const computeGpuIndex =
    normalizeComputeGpuIndex(hardware?.computeGpuIndex) ??
    normalizeComputeGpuIndex(defaults.hardware?.computeGpuIndex);
  return {
    graphicsGpuPreference: normalizeGraphicsGpuPreference(
      hardware?.graphicsGpuPreference,
      normalizeGraphicsGpuPreference(defaults.hardware?.graphicsGpuPreference),
    ),
    ...(computeGpuIndex === undefined ? {} : { computeGpuIndex }),
  };
}
