import type { AmdRocmTarget } from "../shared/settingsTypes";

export type DetectedGpuInfo = {
  name: string | null;
  memoryMb: number | null;
  rtxGeneration: number | null;
  computeCapability: number | null;
  vendor?: "nvidia" | "amd" | "apple" | "unknown";
  rocmArch?: string | null;
  rocmTarget?: AmdRocmTarget | null;
  supportsRocm?: boolean;
  supportsVulkan?: boolean;
  supportsMetal?: boolean;
  unifiedMemoryMb?: number | null;
};
