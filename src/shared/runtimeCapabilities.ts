export type BuildChannel = "stable" | "mac-alpha";

export type RuntimeCapabilities = {
  buildChannel: BuildChannel;
  platform: string;
  arch: string;
  appleSilicon: boolean;
  gpuVendor: "nvidia" | "amd" | "apple" | "unknown";
  gpuName: string | null;
  supportsMetal: boolean;
  unifiedMemoryMb: number | null;
  localGemma: {
    available: boolean;
    metal: boolean;
    minimumUnifiedMemoryMb: {
      minimum12b: number;
      economy26b: number;
      full31b: number;
    };
  };
  inpainting: {
    fluxKlein: {
      available: boolean;
      metal: boolean;
      cpuFallback: false;
      minimumUnifiedMemoryMb: number;
    };
    lamaManga: {
      available: boolean;
      metal: boolean;
      cpuFallback: true;
    };
    aotInpainting: {
      available: boolean;
      metal: boolean;
      cpuFallback: true;
    };
  };
  ocr: {
    cpu: true;
    gpu: boolean;
  };
};

export const APPLE_SILICON_MEMORY_REQUIREMENTS_MB = {
  gemma: {
    minimum12b: 16 * 1024,
    economy26b: 24 * 1024,
    full31b: 32 * 1024,
  },
  fluxKlein: 16 * 1024,
} as const;
