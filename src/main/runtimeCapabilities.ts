import {
  APPLE_SILICON_MEMORY_REQUIREMENTS_MB,
  type RuntimeCapabilities,
} from "../shared/runtimeCapabilities";
import { resolveBuildChannel } from "./buildChannel";
import type { DetectedGpuInfo } from "./gpuInfo";

export function buildRuntimeCapabilities({
  platform = process.platform,
  arch = process.arch,
  gpu,
}: {
  platform?: string;
  arch?: string;
  gpu: DetectedGpuInfo | null;
}): RuntimeCapabilities {
  const appleSilicon = isAppleSilicon(platform, arch);
  const supportsMetal = resolveMetalSupport(appleSilicon, gpu);
  const supportedDesktop = isSupportedDesktop(platform, arch);
  return {
    buildChannel: resolveBuildChannel(platform, arch),
    platform,
    arch,
    appleSilicon,
    gpuVendor: resolveGpuVendor(gpu, appleSilicon),
    gpuName: resolveGpuName(gpu, appleSilicon),
    supportsMetal,
    unifiedMemoryMb: resolveUnifiedMemoryMb(gpu, appleSilicon),
    localGemma: {
      available: supportedDesktop,
      metal: supportsMetal,
      minimumUnifiedMemoryMb: {
        ...APPLE_SILICON_MEMORY_REQUIREMENTS_MB.gemma,
      },
    },
    inpainting: {
      fluxKlein: {
        available: supportedDesktop,
        metal: supportsMetal,
        cpuFallback: false,
        minimumUnifiedMemoryMb: APPLE_SILICON_MEMORY_REQUIREMENTS_MB.fluxKlein,
      },
      lamaManga: {
        available: supportedDesktop,
        metal: supportsMetal,
        cpuFallback: true,
      },
      aotInpainting: {
        available: supportedDesktop,
        metal: supportsMetal,
        cpuFallback: true,
      },
    },
    ocr: {
      cpu: true,
      gpu: platform === "win32",
    },
  };
}

function isAppleSilicon(platform: string, arch: string): boolean {
  return platform === "darwin" && arch === "arm64";
}

function isSupportedDesktop(platform: string, arch: string): boolean {
  return (
    (platform === "win32" && arch === "x64") || isAppleSilicon(platform, arch)
  );
}

function resolveMetalSupport(
  appleSilicon: boolean,
  gpu: DetectedGpuInfo | null,
): boolean {
  return appleSilicon && gpu?.supportsMetal !== false;
}

function resolveGpuVendor(
  gpu: DetectedGpuInfo | null,
  appleSilicon: boolean,
): RuntimeCapabilities["gpuVendor"] {
  return gpu?.vendor ?? (appleSilicon ? "apple" : "unknown");
}

function resolveGpuName(
  gpu: DetectedGpuInfo | null,
  appleSilicon: boolean,
): string | null {
  return gpu?.name ?? (appleSilicon ? "Apple Silicon" : null);
}

function resolveUnifiedMemoryMb(
  gpu: DetectedGpuInfo | null,
  appleSilicon: boolean,
): number | null {
  return appleSilicon ? (gpu?.unifiedMemoryMb ?? gpu?.memoryMb ?? null) : null;
}
