import type { AppSettings } from "../../shared/settingsTypes";
import {
  isAmdLlamaRuntimeProfile,
  isMetalLlamaRuntimeProfile,
  isNvidiaLlamaRuntimeProfile,
  resolveLlamaRuntimeProfile,
} from "./llamaRuntimeProfile";

export type HardwareVendor = "amd" | "nvidia" | "apple" | "unknown";

export function inferHardwareVendorFromDefaults(
  defaults: AppSettings,
): HardwareVendor {
  const profile = resolveLlamaRuntimeProfile(
    {},
    defaults.gemma.llamaRuntimeProfile,
  );
  if (defaults.gemma.llamaRocmTarget || isAmdLlamaRuntimeProfile(profile)) {
    return "amd";
  }
  if (isMetalLlamaRuntimeProfile(profile)) {
    return "apple";
  }
  if (
    defaults.modelProvider === "gemma" &&
    isNvidiaLlamaRuntimeProfile(profile)
  ) {
    return "nvidia";
  }
  return "unknown";
}
