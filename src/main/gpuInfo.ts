import { execFile } from "node:child_process";

let cachedGpuInfoPromise: Promise<DetectedGpuInfo | null> | null = null;
const WINDOWS_AMD_GPU_FIELD_SEPARATOR = "\u001f";

export type GpuVendor = "nvidia" | "amd" | "unknown";
export type AmdRocmTarget =
  | "gfx908"
  | "gfx90a"
  | "gfx103X"
  | "gfx110X"
  | "gfx1150"
  | "gfx1151"
  | "gfx120X";

export type DetectedGpuInfo = {
  name: string | null;
  memoryMb: number | null;
  rtxGeneration: number | null;
  computeCapability: number | null;
  vendor?: GpuVendor;
  rocmArch?: string | null;
  rocmTarget?: AmdRocmTarget | null;
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
        "--format=csv,noheader,nounits",
      ]);
    } catch {
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

    if (values.length === 0) {
      return null;
    }

    return values.sort(
      (left, right) => (right.memoryMb ?? 0) - (left.memoryMb ?? 0),
    )[0];
  } catch {
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
  const values = candidates.filter((value): value is DetectedGpuInfo =>
    Boolean(value),
  );
  if (values.length === 0) {
    return null;
  }
  return values.sort(compareAmdGpuPriority)[0];
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
      [
        "$sep = [char]31;",
        "$pattern = 'AMD|Radeon|ATI|Advanced Micro Devices|VEN_1002|V710';",
        "$video = Get-CimInstance Win32_VideoController | Where-Object { (($_.Name, $_.AdapterCompatibility, $_.VideoProcessor, $_.PNPDeviceID) -join ' ') -match $pattern } | ForEach-Object { @($_.Name, $_.AdapterCompatibility, $_.VideoProcessor, $_.PNPDeviceID, $_.AdapterRAM) -join $sep };",
        "$pnp = Get-CimInstance Win32_PnPEntity | Where-Object { (($_.Name, $_.Manufacturer, $_.PNPClass, $_.DeviceID) -join ' ') -match $pattern } | ForEach-Object { @($_.Name, $_.Manufacturer, $_.PNPClass, $_.DeviceID, '') -join $sep };",
        "$video; $pnp",
      ].join(" "),
    ]);
    return stdout.split(/\r?\n/).map(parseWindowsAmdGpuLine);
  } catch {
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
  } catch {
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
  } catch {
    return [];
  }
}

export function parseWindowsAmdGpuLine(line: string): DetectedGpuInfo | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const fields = parseWindowsAmdGpuFields(trimmed);
  const [rawName, rawCompatibility, rawProcessor, rawPnpDeviceId, rawBytes] =
    fields;
  const hardwareText = [rawName, rawCompatibility, rawProcessor, rawPnpDeviceId]
    .filter(Boolean)
    .join(" ");
  const name = pickAmdDisplayName(
    rawName,
    rawCompatibility,
    rawProcessor,
    rawPnpDeviceId,
  );
  const bytes = Number(rawBytes);
  const parsedMemoryMb =
    Number.isFinite(bytes) && bytes > 0
      ? Math.round(bytes / 1024 / 1024)
      : null;
  const inferredMemoryMb = inferAmdVramMbFromName(hardwareText || name);
  const memoryMb =
    parsedMemoryMb && parsedMemoryMb >= 8192
      ? parsedMemoryMb
      : (inferredMemoryMb ?? parsedMemoryMb);
  const rocmTarget = inferAmdRocmTargetFromName(hardwareText || name);
  return {
    name,
    memoryMb,
    rtxGeneration: null,
    computeCapability: null,
    vendor: "amd",
    rocmArch: null,
    rocmTarget,
    supportsRocm: Boolean(rocmTarget),
    supportsVulkan: true,
  };
}

export function inferAmdVramMbFromName(
  name: string | null | undefined,
): number | null {
  const normalized = String(name ?? "").toLowerCase();
  if (!normalized) {
    return null;
  }
  const explicitGib = normalized.match(/\b(\d{1,3})\s*(?:gib|gb)\b/);
  if (explicitGib) {
    const parsed = Number(explicitGib[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed * 1024);
    }
  }
  const rules: Array<[RegExp, number]> = [
    [/\b(?:amd\s+)?(?:radeon\s+)?(?:ai\s+)?pro\s+r\s*9700\b/, 32768],
    [/\b(rx\s*)?9070\s*(xt|gre)?\b/, 16384],
    [/\b(rx\s*)?9060\s*xt\b/, 8192],
    [/\b(rx\s*)?9060\b/, 8192],
    [/\b(?:radeon\s+)?pro\s+w\s*7900\b/, 49152],
    [/\b(?:radeon\s+)?pro\s+w\s*7800\b/, 32768],
    [/\b(?:radeon\s+)?pro\s+w\s*7700\b/, 16384],
    [/\b(?:radeon\s+)?pro\s+w\s*(7600|7500)\b/, 8192],
    [
      /\b(?:amd\s+)?(?:radeon\s+)?(?:pro\s+)?v\s*710(?:\s*mxgpu)?(?:[-\s]\d+q)?\b|\bven_1002&dev_746[01]\b/,
      28672,
    ],
    [/\b(?:radeon\s+)?pro\s+v\s*620\b/, 32768],
    [/\b(?:radeon\s+)?pro\s+w\s*6800\b/, 32768],
    [/\b(?:radeon\s+)?pro\s+w\s*6600\b/, 8192],
    [/\b(rx\s*)?7900\s*xtx\b/, 24576],
    [/\b(rx\s*)?7900\s*xt\b/, 20480],
    [/\b(rx\s*)?7900\s*gre\b/, 16384],
    [/\b(rx\s*)?7800\s*xt\b/, 16384],
    [/\b(rx\s*)?7800\b/, 16384],
    [/\b(rx\s*)?7700\s*xt\b/, 12288],
    [/\b(rx\s*)?7700\b/, 16384],
    [/\b(rx\s*)?7650\s*gre\b/, 8192],
    [/\b(rx\s*)?7600\s*xt\b/, 16384],
    [/\b(rx\s*)?7600\b/, 8192],
    [/\b(rx\s*)?6950\s*xt\b/, 16384],
    [/\b(rx\s*)?6900\s*xt\b/, 16384],
    [/\b(rx\s*)?6800\s*xt\b/, 16384],
    [/\b(rx\s*)?6800\b/, 16384],
    [/\b(rx\s*)?6750\s*xt\b/, 12288],
    [/\b(rx\s*)?6700\s*xt\b/, 12288],
    [/\b(rx\s*)?6600\s*xt\b/, 8192],
    [/\b(rx\s*)?6600\b/, 8192],
    [/\b(rx\s*)?6500\s*xt\b/, 4096],
    [/\b(rx\s*)?6400\b/, 4096],
  ];
  return rules.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

export function parseRocmSmiGpuLine(line: string): DetectedGpuInfo | null {
  const trimmed = line.trim();
  if (!trimmed || /^(card|device)\s*(?:,|$)/i.test(trimmed)) {
    return null;
  }
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
    return Number.isFinite(parsed) && parsed > 0
      ? Math.round(parsed * 1024)
      : null;
  }
  return null;
}

export function parseRocmArch(value: string): string | null {
  const match = value.match(/\bgfx[0-9a-f]+(?:[:_a-z0-9.-]*)?\b/i);
  return match ? match[0].toLowerCase() : null;
}

export function normalizeAmdRocmTarget(value: unknown): AmdRocmTarget | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "");
  if (!normalized) {
    return null;
  }
  if (normalized === "gfx908") {
    return "gfx908";
  }
  if (normalized === "gfx90a") {
    return "gfx90a";
  }
  if (/^gfx103[0-9a-fx]*$/.test(normalized)) {
    return "gfx103X";
  }
  if (/^gfx110[0-9a-fx]*$/.test(normalized)) {
    return "gfx110X";
  }
  if (normalized === "gfx1150") {
    return "gfx1150";
  }
  if (normalized === "gfx1151") {
    return "gfx1151";
  }
  if (/^gfx120[0-9a-fx]*$/.test(normalized)) {
    return "gfx120X";
  }
  if (normalized === "gfx103x") {
    return "gfx103X";
  }
  if (normalized === "gfx110x") {
    return "gfx110X";
  }
  if (normalized === "gfx120x") {
    return "gfx120X";
  }
  return null;
}

export function resolveAmdRocmTargetFromArch(
  arch: string | null | undefined,
): AmdRocmTarget | null {
  return normalizeAmdRocmTarget(parseRocmArch(String(arch ?? "")) ?? arch);
}

export function inferAmdRocmTargetFromName(
  name: string | null | undefined,
): AmdRocmTarget | null {
  const normalized = String(name ?? "")
    .toLowerCase()
    .replace(/[™®]/g, " ");
  if (!normalized.trim()) {
    return null;
  }

  if (/\bmi\s*100\b|\binstinct\s+mi100\b/.test(normalized)) {
    return "gfx908";
  }
  if (
    /\bmi\s*(200|210|250)\b|\binstinct\s+mi(200|210|250)\b/.test(normalized)
  ) {
    return "gfx90a";
  }
  if (
    /\b(?:amd\s+)?(?:radeon\s+)?(?:ai\s+)?pro\s+r\s*9700\b/.test(normalized) ||
    /\b(rx\s*)?90(60|70)\b|\b(rx\s*)?90(60|70)\s*(xt|gre)\b/.test(normalized)
  ) {
    return "gfx120X";
  }
  if (
    /\b(?:amd\s+)?(?:radeon\s+)?(?:pro\s+)?v\s*710(?:\s*mxgpu)?(?:[-\s]\d+q)?\b/.test(
      normalized,
    ) ||
    /\bven_1002&dev_746[01]\b/.test(normalized) ||
    /\bven_1002&dev_7480\b/.test(normalized) ||
    /\b(rx\s*)?7(600|650|700|800|900)\b|\b(rx\s*)?7(600|650|700|800|900)\s*(xt|xtx|gre)\b/.test(
      normalized,
    ) ||
    /\b(?:radeon\s+)?(?:pro\s*)?w7(500|600|700|800|900)\b/.test(normalized) ||
    /\bradeon\s+(740m|760m|780m)\b/.test(normalized)
  ) {
    return "gfx110X";
  }
  if (
    /\b(?:radeon\s+)?pro\s+(v\s*620|w\s*(6600|6800))\b/.test(normalized) ||
    /\b(rx\s*)?6(400|500|600|650|700|750|800|900|950)\b|\b(rx\s*)?6(400|500|600|650|700|750|800|900|950)\s*(xt|m|s)\b/.test(
      normalized,
    )
  ) {
    return "gfx103X";
  }
  if (
    /\bryzen\s+ai\s+max\b|\bstrix\s+halo\b|\bradeon\s+80(50|60)s\b/.test(
      normalized,
    )
  ) {
    return "gfx1151";
  }
  if (
    /\bryzen\s+ai\s+9\s+(hx\s*37(0|5)|365)\b|\bradeon\s+(880m|890m)\b/.test(
      normalized,
    )
  ) {
    return "gfx1150";
  }
  return null;
}

function parseWindowsAmdGpuFields(line: string): string[] {
  if (line.includes(WINDOWS_AMD_GPU_FIELD_SEPARATOR)) {
    const fields = line
      .split(WINDOWS_AMD_GPU_FIELD_SEPARATOR)
      .map((part) => part.trim());
    while (fields.length < 5) {
      fields.push("");
    }
    return fields.slice(0, 5);
  }
  const [rawName = "", rawBytes = ""] = line
    .split(",")
    .map((part) => part.trim());
  return [rawName, "", "", "", rawBytes];
}

function pickAmdDisplayName(
  rawName: string | null | undefined,
  rawCompatibility: string | null | undefined,
  rawProcessor: string | null | undefined,
  rawPnpDeviceId: string | null | undefined,
): string | null {
  const candidates = [rawName, rawProcessor, rawCompatibility, rawPnpDeviceId]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return (
    candidates.find((value) =>
      /\bradeon\b|\binstinct\b|\bryzen\s+ai\b|\bai\s+pro\b|\bpro\s+[rvw]\s*\d+\b|\brx\s*\d+\b|\bmi\s*\d+\b/i.test(
        value,
      ),
    ) ??
    candidates.find((value) =>
      /amd|advanced micro devices|ven_1002/i.test(value),
    ) ??
    candidates[0] ??
    null
  );
}

export function resolveAmdRocmTargetFromInfo(
  info: DetectedGpuInfo | null | undefined,
): AmdRocmTarget | null {
  return (
    normalizeAmdRocmTarget(info?.rocmTarget) ??
    resolveAmdRocmTargetFromArch(info?.rocmArch) ??
    inferAmdRocmTargetFromName(info?.name)
  );
}

function compareAmdGpuPriority(
  left: DetectedGpuInfo,
  right: DetectedGpuInfo,
): number {
  const leftRocm = resolveAmdRocmTargetFromInfo(left) ? 1 : 0;
  const rightRocm = resolveAmdRocmTargetFromInfo(right) ? 1 : 0;
  if (leftRocm !== rightRocm) {
    return rightRocm - leftRocm;
  }
  return (right.memoryMb ?? 0) - (left.memoryMb ?? 0);
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
