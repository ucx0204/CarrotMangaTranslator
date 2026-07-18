import { execFile } from "node:child_process";
import { cpus, totalmem } from "node:os";
import type { DetectedGpuInfo } from "./gpuInfoTypes";

export async function detectAppleGpuInfo(): Promise<DetectedGpuInfo | null> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return null;
  }
  let chipName = cpus()[0]?.model?.trim() || "Apple Silicon";
  try {
    chipName =
      (
        await execFileText("/usr/sbin/sysctl", [
          "-n",
          "machdep.cpu.brand_string",
        ])
      ).trim() || chipName;
  } catch (_error) {
    // error-policy-allow: os.cpus() is the intentional Apple chip-name fallback.
    // os.cpus() still provides a safe Apple Silicon fallback.
  }
  return buildAppleGpuInfo(chipName, totalmem());
}

export function buildAppleGpuInfo(
  chipName: string,
  unifiedMemoryBytes: number,
): DetectedGpuInfo {
  const unifiedMemoryMb =
    Number.isFinite(unifiedMemoryBytes) && unifiedMemoryBytes > 0
      ? Math.round(unifiedMemoryBytes / 1024 / 1024)
      : null;
  return {
    name: chipName.trim() || "Apple Silicon",
    memoryMb: unifiedMemoryMb,
    unifiedMemoryMb,
    rtxGeneration: null,
    computeCapability: null,
    vendor: "apple",
    rocmArch: null,
    rocmTarget: null,
    supportsRocm: false,
    supportsVulkan: false,
    supportsMetal: true,
  };
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}
