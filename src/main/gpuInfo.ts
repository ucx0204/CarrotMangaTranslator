import { execFile } from "node:child_process";
import {
  inferAmdRocmTargetFromName,
  parseRocmArch,
  resolveAmdRocmTargetFromArch,
} from "./amdRocmTargets";
import { detectAppleGpuInfo } from "./appleGpuInfo";
import type { DetectedGpuInfo } from "./gpuInfoTypes";
import {
  buildWindowsAmdGpuQueryCommand,
  parseWindowsAmdGpuLines,
  selectBestAmdGpuInfo,
} from "./windowsAmdGpuInfo";

export type { DetectedGpuInfo } from "./gpuInfoTypes";

export {
  inferAmdRocmTargetFromName,
  normalizeAmdRocmTarget,
  resolveAmdRocmTargetFromArch,
  resolveAmdRocmTargetFromInfo,
} from "./amdRocmTargets";

export class GpuInfoDetector {
  private cachedPromise: Promise<DetectedGpuInfo | null> | null = null;

  constructor(private readonly query: () => Promise<DetectedGpuInfo | null>) {}

  detect(): Promise<DetectedGpuInfo | null> {
    this.cachedPromise ??= this.query();
    return this.cachedPromise;
  }
}

const defaultGpuInfoDetector = new GpuInfoDetector(queryBestGpuInfo);

export function detectBestGpuInfo(): Promise<DetectedGpuInfo | null> {
  return defaultGpuInfoDetector.detect();
}

async function queryBestGpuInfo(): Promise<DetectedGpuInfo | null> {
  const apple = await detectAppleGpuInfo();
  if (apple) return apple;
  const nvidia = await queryNvidiaGpuInfo();
  if (nvidia) return nvidia;
  return queryAmdGpuInfo();
}

async function queryNvidiaGpuInfo(): Promise<DetectedGpuInfo | null> {
  try {
    let stdout = "";
    try {
      stdout = await execFileAsync("nvidia-smi", [
        "--query-gpu=name,memory.total,compute_cap",
        "--format=csv,noheader,nounits",
      ]);
    } catch (_error) {
      stdout = await execFileAsync("nvidia-smi", [
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits",
      ]);
    }
    const values = stdout
      .split(/\r?\n/)
      .map(parseNvidiaSmiGpuLine)
      .filter((value): value is DetectedGpuInfo =>
        Boolean(value?.memoryMb && value.memoryMb > 0),
      );
    return values.length > 0
      ? values.sort(
          (left, right) => (right.memoryMb ?? 0) - (left.memoryMb ?? 0),
        )[0]
      : null;
  } catch (_error) {
    return null;
  }
}

async function queryAmdGpuInfo(): Promise<DetectedGpuInfo | null> {
  const rocmCandidates = await queryRocmSmiGpuInfo();
  const candidates =
    process.platform === "win32"
      ? [...(await queryWindowsAmdGpuInfo()), ...rocmCandidates]
      : rocmCandidates.length > 0
        ? rocmCandidates
        : await queryLspciAmdGpuInfo();
  return selectBestAmdGpuInfo(candidates);
}

function parseNvidiaSmiGpuLine(line: string): DetectedGpuInfo | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(",").map((part) => part.trim());
  const name = parts.length >= 2 ? parts[0] : null;
  const memoryText = parts.length >= 2 ? parts[1] : parts[0];
  const memoryMb = Number(memoryText);
  if (!Number.isFinite(memoryMb) || memoryMb <= 0) return null;
  return {
    name,
    memoryMb,
    rtxGeneration: parseRtxGeneration(name),
    computeCapability: parseComputeCapability(parts[2]),
    vendor: "nvidia",
    supportsRocm: false,
    supportsVulkan: true,
  };
}

async function queryWindowsAmdGpuInfo(): Promise<
  Array<DetectedGpuInfo | null>
> {
  try {
    const stdout = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      buildWindowsAmdGpuQueryCommand(),
    ]);
    return parseWindowsAmdGpuLines(stdout.split(/\r?\n/));
  } catch (_error) {
    return [];
  }
}

async function queryRocmSmiGpuInfo(): Promise<Array<DetectedGpuInfo | null>> {
  try {
    const stdout = await execFileAsync("rocm-smi", [
      "--showproductname",
      "--showmeminfo",
      "vram",
      "--csv",
    ]);
    return stdout.split(/\r?\n/).map(parseRocmSmiGpuLine);
  } catch (_error) {
    return [];
  }
}

async function queryLspciAmdGpuInfo(): Promise<Array<DetectedGpuInfo | null>> {
  try {
    const stdout = await execFileAsync("sh", [
      "-lc",
      "lspci | grep -Ei 'VGA|Display|3D' | grep -Ei 'AMD|ATI|Radeon'",
    ]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => ({
        name,
        memoryMb: null,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd" as const,
        rocmArch: null,
        rocmTarget: inferAmdRocmTargetFromName(name),
        supportsRocm: false,
        supportsVulkan: true,
      }));
  } catch (_error) {
    return [];
  }
}

export function parseRocmSmiGpuLine(line: string): DetectedGpuInfo | null {
  const trimmed = line.trim();
  if (!trimmed || /^(card|device)\s*(?:,|$)/i.test(trimmed)) return null;
  const parts = trimmed
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""));
  const name =
    parts.find((part) => /radeon|instinct|amd/i.test(part)) ||
    parts[1] ||
    parts[0] ||
    null;
  const memoryMb = parseMemoryMb(parts.join(" "));
  const arch = parseRocmArch(parts.join(" "));
  const rocmTarget =
    resolveAmdRocmTargetFromArch(arch) ?? inferAmdRocmTargetFromName(name);
  return {
    name,
    memoryMb,
    rtxGeneration: null,
    computeCapability: null,
    vendor: "amd",
    rocmArch: arch,
    rocmTarget,
    supportsRocm: Boolean(rocmTarget),
    supportsVulkan: true,
  };
}

function parseComputeCapability(
  value: string | null | undefined,
): number | null {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseRtxGeneration(
  name: string | null | undefined,
): number | null {
  const match = String(name ?? "").match(/\bRTX\s*([2345]\d{3})\b/i);
  return match ? Math.floor(Number(match[1]) / 100) : null;
}

function parseMemoryMb(value: string): number | null {
  const mib = value.match(/(\d+(?:\.\d+)?)\s*(?:mib|mb)\b/i);
  if (mib) {
    const parsed = Number(mib[1]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  }
  const gib = value.match(/(\d+(?:\.\d+)?)\s*(?:gib|gb)\b/i);
  if (!gib) return null;
  const parsed = Number(gib[1]);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.round(parsed * 1024)
    : null;
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
