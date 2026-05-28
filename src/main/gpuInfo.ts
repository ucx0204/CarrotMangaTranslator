import { execFile } from "node:child_process";

let cachedGpuMemoryMbPromise: Promise<number | null> | null = null;
let cachedGpuInfoPromise: Promise<DetectedGpuInfo | null> | null = null;

export type DetectedGpuInfo = {
  name: string | null;
  memoryMb: number | null;
  rtxGeneration: number | null;
};

export function detectMaxGpuMemoryMb(): Promise<number | null> {
  if (!cachedGpuMemoryMbPromise) {
    cachedGpuMemoryMbPromise = detectBestGpuInfo().then((info) => info?.memoryMb ?? null);
  }
  return cachedGpuMemoryMbPromise;
}

export function detectBestGpuInfo(): Promise<DetectedGpuInfo | null> {
  if (!cachedGpuInfoPromise) {
    cachedGpuInfoPromise = queryBestGpuInfo();
  }
  return cachedGpuInfoPromise;
}

async function queryBestGpuInfo(): Promise<DetectedGpuInfo | null> {
  try {
    const stdout = await execFileAsync("nvidia-smi", [
      "--query-gpu=name,memory.total",
      "--format=csv,noheader,nounits"
    ]);
    const values = stdout
      .split(/\r?\n/)
      .map(parseNvidiaSmiGpuLine)
      .filter((value): value is DetectedGpuInfo => Boolean(value?.memoryMb && value.memoryMb > 0));

    if (values.length === 0) {
      return null;
    }

    return values.sort((left, right) => (right.memoryMb ?? 0) - (left.memoryMb ?? 0))[0];
  } catch {
    return null;
  }
}

function parseNvidiaSmiGpuLine(line: string): DetectedGpuInfo | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const lastComma = trimmed.lastIndexOf(",");
  const name = lastComma >= 0 ? trimmed.slice(0, lastComma).trim() : null;
  const memoryText = lastComma >= 0 ? trimmed.slice(lastComma + 1).trim() : trimmed;
  const memoryMb = Number(memoryText);
  if (!Number.isFinite(memoryMb) || memoryMb <= 0) {
    return null;
  }

  return {
    name,
    memoryMb,
    rtxGeneration: parseRtxGeneration(name)
  };
}

export function parseRtxGeneration(name: string | null | undefined): number | null {
  const normalized = String(name ?? "");
  const match = normalized.match(/\bRTX\s*([2345]\d{3})\b/i);
  if (!match) {
    return null;
  }
  return Math.floor(Number(match[1]) / 100);
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
