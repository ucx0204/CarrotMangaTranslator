import { execFile } from "node:child_process";

let cachedGpuInfoPromise: Promise<DetectedGpuInfo | null> | null = null;

export type GpuVendor = "nvidia" | "amd" | "unknown";

export type DetectedGpuInfo = {
  name: string | null;
  memoryMb: number | null;
  rtxGeneration: number | null;
  computeCapability: number | null;
  vendor?: GpuVendor;
  rocmArch?: string | null;
  supportsRocm?: boolean;
  supportsVulkan?: boolean;
};

export function detectBestGpuInfo(): Promise<DetectedGpuInfo | null> {
  if (!cachedGpuInfoPromise) {
    cachedGpuInfoPromise = queryBestGpuInfo();
  }
  return cachedGpuInfoPromise;
}

async function queryBestGpuInfo(): Promise<DetectedGpuInfo | null> {
  const nvidia = await queryNvidiaGpuInfo();
  if (nvidia) {
    return nvidia;
  }
  const amd = await queryAmdGpuInfo();
  if (amd) {
    return amd;
  }
  return null;
}

async function queryNvidiaGpuInfo(): Promise<DetectedGpuInfo | null> {
  try {
    let stdout = "";
    try {
      stdout = await execFileAsync("nvidia-smi", [
        "--query-gpu=name,memory.total,compute_cap",
        "--format=csv,noheader,nounits"
      ]);
    } catch {
      stdout = await execFileAsync("nvidia-smi", [
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits"
      ]);
    }
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

async function queryAmdGpuInfo(): Promise<DetectedGpuInfo | null> {
  const candidates = process.platform === "win32"
    ? await queryWindowsAmdGpuInfo()
    : await queryUnixAmdGpuInfo();
  const values = candidates.filter((value): value is DetectedGpuInfo => Boolean(value));
  if (values.length === 0) {
    return null;
  }
  return values.sort((left, right) => (right.memoryMb ?? 0) - (left.memoryMb ?? 0))[0];
}

function parseNvidiaSmiGpuLine(line: string): DetectedGpuInfo | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(",").map((part) => part.trim());
  const name = parts.length >= 2 ? parts[0] : null;
  const memoryText = parts.length >= 2 ? parts[1] : parts[0];
  const memoryMb = Number(memoryText);
  if (!Number.isFinite(memoryMb) || memoryMb <= 0) {
    return null;
  }
  const computeCapability = parseComputeCapability(parts[2]);

  return {
    name,
    memoryMb,
    rtxGeneration: parseRtxGeneration(name),
    computeCapability,
    vendor: "nvidia",
    supportsRocm: false,
    supportsVulkan: true
  };
}

async function queryWindowsAmdGpuInfo(): Promise<Array<DetectedGpuInfo | null>> {
  try {
    const stdout = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'AMD|Radeon' } | ForEach-Object { \"$($_.Name),$($_.AdapterRAM)\" }"
    ]);
    return stdout.split(/\r?\n/).map(parseWindowsAmdGpuLine);
  } catch {
    return [];
  }
}

async function queryUnixAmdGpuInfo(): Promise<Array<DetectedGpuInfo | null>> {
  const fromRocmSmi = await queryRocmSmiGpuInfo();
  if (fromRocmSmi.length > 0) {
    return fromRocmSmi;
  }
  return queryLspciAmdGpuInfo();
}

async function queryRocmSmiGpuInfo(): Promise<Array<DetectedGpuInfo | null>> {
  try {
    const stdout = await execFileAsync("rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--csv"]);
    return stdout.split(/\r?\n/).map(parseRocmSmiGpuLine);
  } catch {
    return [];
  }
}

async function queryLspciAmdGpuInfo(): Promise<Array<DetectedGpuInfo | null>> {
  try {
    const stdout = await execFileAsync("sh", ["-lc", "lspci | grep -Ei 'VGA|Display|3D' | grep -Ei 'AMD|ATI|Radeon'"]);
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
        supportsRocm: false,
        supportsVulkan: true
      }));
  } catch {
    return [];
  }
}

export function parseWindowsAmdGpuLine(line: string): DetectedGpuInfo | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const [rawName, rawBytes] = trimmed.split(",").map((part) => part.trim());
  const name = rawName || null;
  const bytes = Number(rawBytes);
  const parsedMemoryMb = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 / 1024) : null;
  const inferredMemoryMb = inferAmdVramMbFromName(name);
  const memoryMb = parsedMemoryMb && parsedMemoryMb >= 4096 ? parsedMemoryMb : inferredMemoryMb;
  return {
    name,
    memoryMb,
    rtxGeneration: null,
    computeCapability: null,
    vendor: "amd",
    rocmArch: null,
    supportsRocm: false,
    supportsVulkan: true
  };
}

export function inferAmdVramMbFromName(name: string | null | undefined): number | null {
  const normalized = String(name ?? "").toLowerCase();
  if (!normalized) {
    return null;
  }
  const rules: Array<[RegExp, number]> = [
    [/\b(rx\s*)?7900\s*xtx\b/, 24576],
    [/\b(rx\s*)?7900\s*xt\b/, 20480],
    [/\b(rx\s*)?7900\s*gre\b/, 16384],
    [/\b(rx\s*)?7800\s*xt\b/, 16384],
    [/\b(rx\s*)?7700\s*xt\b/, 12288],
    [/\b(rx\s*)?7600\s*xt\b/, 16384],
    [/\b(rx\s*)?7600\b/, 8192],
    [/\b(rx\s*)?6950\s*xt\b/, 16384],
    [/\b(rx\s*)?6900\s*xt\b/, 16384],
    [/\b(rx\s*)?6800\s*xt\b/, 16384],
    [/\b(rx\s*)?6800\b/, 16384],
    [/\b(rx\s*)?6750\s*xt\b/, 12288],
    [/\b(rx\s*)?6700\s*xt\b/, 12288],
    [/\b(rx\s*)?6600\s*xt\b/, 8192],
    [/\b(rx\s*)?6600\b/, 8192]
  ];
  return rules.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

export function parseRocmSmiGpuLine(line: string): DetectedGpuInfo | null {
  const trimmed = line.trim();
  if (!trimmed || /^(card|device)\s*(?:,|$)/i.test(trimmed)) {
    return null;
  }
  const parts = trimmed.split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
  const name = parts.find((part) => /radeon|instinct|amd/i.test(part)) || parts[1] || parts[0] || null;
  const memoryMb = parseMemoryMb(parts.join(" "));
  const arch = parseRocmArch(parts.join(" "));
  return {
    name,
    memoryMb,
    rtxGeneration: null,
    computeCapability: null,
    vendor: "amd",
    rocmArch: arch,
    supportsRocm: Boolean(arch) || process.platform !== "win32",
    supportsVulkan: true
  };
}

function parseComputeCapability(value: string | null | undefined): number | null {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseRtxGeneration(name: string | null | undefined): number | null {
  const normalized = String(name ?? "");
  const match = normalized.match(/\bRTX\s*([2345]\d{3})\b/i);
  if (!match) {
    return null;
  }
  return Math.floor(Number(match[1]) / 100);
}

function parseMemoryMb(value: string): number | null {
  const mib = value.match(/(\d+(?:\.\d+)?)\s*(?:mib|mb)\b/i);
  if (mib) {
    const parsed = Number(mib[1]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  }
  const gib = value.match(/(\d+(?:\.\d+)?)\s*(?:gib|gb)\b/i);
  if (gib) {
    const parsed = Number(gib[1]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1024) : null;
  }
  return null;
}

function parseRocmArch(value: string): string | null {
  const match = value.match(/\bgfx[0-9a-f]+(?:[:_a-z0-9.-]*)?\b/i);
  return match ? match[0] : null;
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
