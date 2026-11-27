import type { RuntimeGpuVendor } from "../shared/settingsTypes";
import type { AmdRocmTarget } from "../shared/settingsTypes";

export type DetectedGpuInfo = {
  name: string | null;
  memoryMb: number | null;
  rtxGeneration: number | null;
  computeCapability: number | null;
  /** Physical NVIDIA identity from the same query as computeCapability. */
  nvidiaUuid?: string;
  vendor?: RuntimeGpuVendor;
  rocmArch?: string | null;
  rocmTarget?: AmdRocmTarget | null;
  supportsRocm?: boolean;
  supportsVulkan?: boolean;
  supportsMetal?: boolean;
  supportsQwenMetal?: boolean;
  unifiedMemoryMb?: number | null;
};
