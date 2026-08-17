import {
  inferAmdRocmTargetFromName,
  resolveAmdRocmTargetFromInfo,
} from "./amdRocmTargets";
import type { DetectedGpuInfo } from "./gpuInfoTypes";

const WINDOWS_AMD_GPU_FIELD_SEPARATOR = "\u001f";
const WINDOWS_AMD_GPU_FIELD_COUNT = 8;

type WindowsAmdGpuCandidate = {
  info: DetectedGpuInfo;
  pnpDeviceId: string | null;
};

export function buildWindowsAmdGpuQueryCommand(): string {
  return [
    "$sep = [char]31;",
    "$pattern = 'AMD|Radeon|ATI|Advanced Micro Devices|VEN_1002|V710';",
    "$displayClass = '{4d36e968-e325-11ce-bfc1-08002be10318}';",
    "$isActive = { param($item) $code = $item.ConfigManagerErrorCode; $present = $item.Present; ($null -eq $code -or [int]$code -eq 0) -and ($null -eq $present -or [bool]$present) };",
    "$video = Get-CimInstance Win32_VideoController | Where-Object { (($_.Name, $_.AdapterCompatibility, $_.VideoProcessor, $_.PNPDeviceID) -join ' ') -match $pattern -and (& $isActive $_) } | ForEach-Object { @($_.Name, $_.AdapterCompatibility, $_.VideoProcessor, $_.PNPDeviceID, $_.AdapterRAM, 'video', $_.ConfigManagerErrorCode, $_.Present) -join $sep };",
    "$pnp = Get-CimInstance Win32_PnPEntity | Where-Object { ($_.PNPClass -eq 'Display' -or $_.ClassGuid -eq $displayClass) -and (($_.Name, $_.Manufacturer, $_.PNPClass, $_.DeviceID) -join ' ') -match $pattern -and (& $isActive $_) } | ForEach-Object { @($_.Name, $_.Manufacturer, $_.PNPClass, $_.DeviceID, '', 'pnp', $_.ConfigManagerErrorCode, $_.Present) -join $sep };",
    "$video; $pnp",
  ].join(" ");
}

export function parseWindowsAmdGpuLine(line: string): DetectedGpuInfo | null {
  return parseWindowsAmdGpuCandidate(line)?.info ?? null;
}

export function parseWindowsAmdGpuLines(
  lines: readonly string[],
): DetectedGpuInfo[] {
  const unique = new Map<string, DetectedGpuInfo>();
  const unkeyed: DetectedGpuInfo[] = [];
  for (const line of lines) {
    const candidate = parseWindowsAmdGpuCandidate(line);
    if (!candidate) continue;
    const key = normalizeWindowsPnpDeviceId(candidate.pnpDeviceId);
    if (!key) {
      unkeyed.push(candidate.info);
      continue;
    }
    const existing = unique.get(key);
    unique.set(
      key,
      existing ? mergeAmdGpuInfo(existing, candidate.info) : candidate.info,
    );
  }
  return [...unique.values(), ...unkeyed];
}

export function selectBestAmdGpuInfo(
  candidates: ReadonlyArray<DetectedGpuInfo | null>,
): DetectedGpuInfo | null {
  const values = candidates.filter((value): value is DetectedGpuInfo =>
    Boolean(value),
  );
  return values.length > 0 ? [...values].sort(compareAmdGpuPriority)[0] : null;
}

function parseWindowsAmdGpuCandidate(
  line: string,
): WindowsAmdGpuCandidate | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const [
    rawName,
    rawCompatibility,
    rawProcessor,
    rawPnpDeviceId,
    rawBytes,
    _source,
    rawConfigManagerErrorCode,
    rawPresent,
  ] = parseWindowsAmdGpuFields(trimmed);
  if (!isActiveWindowsGpuRecord(rawConfigManagerErrorCode, rawPresent)) {
    return null;
  }
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
    info: {
      name,
      memoryMb,
      rtxGeneration: null,
      computeCapability: null,
      vendor: "amd",
      rocmArch: null,
      rocmTarget,
      supportsRocm: Boolean(rocmTarget),
      supportsVulkan: true,
    },
    pnpDeviceId: rawPnpDeviceId || null,
  };
}

function isActiveWindowsGpuRecord(
  rawConfigManagerErrorCode: string,
  rawPresent: string,
): boolean {
  const configManagerErrorCode = Number(rawConfigManagerErrorCode);
  if (
    rawConfigManagerErrorCode !== "" &&
    (!Number.isInteger(configManagerErrorCode) || configManagerErrorCode !== 0)
  ) {
    return false;
  }
  return !/^(?:false|no|0)$/i.test(rawPresent);
}

function normalizeWindowsPnpDeviceId(value: string | null): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized || null;
}

function mergeAmdGpuInfo(
  left: DetectedGpuInfo,
  right: DetectedGpuInfo,
): DetectedGpuInfo {
  const rocmArch = left.rocmArch ?? right.rocmArch ?? null;
  const rocmTarget =
    resolveAmdRocmTargetFromInfo(left) ??
    resolveAmdRocmTargetFromInfo(right) ??
    null;
  return {
    name: pickBestAmdDisplayName([left.name, right.name]),
    memoryMb: maxNullableNumber(left.memoryMb, right.memoryMb),
    rtxGeneration: null,
    computeCapability: null,
    vendor: "amd",
    rocmArch,
    rocmTarget,
    supportsRocm: Boolean(rocmTarget),
    supportsVulkan: Boolean(left.supportsVulkan || right.supportsVulkan),
  };
}

function maxNullableNumber(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  const values = [left, right].filter((value): value is number =>
    Number.isFinite(value),
  );
  return values.length > 0 ? Math.max(...values) : null;
}

function inferAmdVramMbFromName(
  name: string | null | undefined,
): number | null {
  const normalized = String(name ?? "").toLowerCase();
  if (!normalized) return null;
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
    [/\b(?:rx\s*)?7900m\b/, 16384],
    [/\b(?:rx\s*)?7800m\b/, 12288],
    [/\b(?:rx\s*)?7700(?:m|s)\b/, 8192],
    [/\b(?:rx\s*)?7600m\s*xt\b/, 8192],
    [/\b(?:rx\s*)?7600(?:m|s)\b/, 8192],
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
    [/\b(?:rx\s*)?6850m\s*xt\b/, 12288],
    [/\b(?:rx\s*)?6800m\b/, 12288],
    [/\b(?:rx\s*)?6700m\b/, 10240],
    [/\b(?:rx\s*)?6650m(?:\s*xt)?\b/, 8192],
    [/\b(?:rx\s*)?6600m\b/, 8192],
    [/\b(?:rx\s*)?6550m\b/, 4096],
    [/\b(?:rx\s*)?6500m\b/, 4096],
    [/\b(?:rx\s*)?6450m\b/, 4096],
    [/\b(?:rx\s*)?6300m\b/, 2048],
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

function parseWindowsAmdGpuFields(line: string): string[] {
  if (line.includes(WINDOWS_AMD_GPU_FIELD_SEPARATOR)) {
    const fields = line
      .split(WINDOWS_AMD_GPU_FIELD_SEPARATOR)
      .map((part) => part.trim());
    while (fields.length < WINDOWS_AMD_GPU_FIELD_COUNT) fields.push("");
    return fields.slice(0, WINDOWS_AMD_GPU_FIELD_COUNT);
  }
  const [rawName = "", rawBytes = ""] = line
    .split(",")
    .map((part) => part.trim());
  return [rawName, "", "", "", rawBytes, "legacy", "", ""];
}

function pickAmdDisplayName(
  rawName: string | null | undefined,
  rawCompatibility: string | null | undefined,
  rawProcessor: string | null | undefined,
  rawPnpDeviceId: string | null | undefined,
): string | null {
  return pickBestAmdDisplayName([
    rawName,
    rawProcessor,
    rawCompatibility,
    rawPnpDeviceId,
  ]);
}

function pickBestAmdDisplayName(
  values: ReadonlyArray<string | null | undefined>,
): string | null {
  const candidates = values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return (
    candidates
      .map((value, index) => ({
        value,
        index,
        score: scoreAmdDisplayName(value),
      }))
      .sort(
        (left, right) => right.score - left.score || left.index - right.index,
      )[0]?.value ?? null
  );
}

function scoreAmdDisplayName(value: string): number {
  if (
    /\bradeon\s+(?:rx|pro)\b|\binstinct\b|\bryzen\s+ai\b|\bai\s+pro\b|\bpro\s+[rvw]\s*\d+\b|\brx\s*\d+\b|\bmi\s*\d+\b/i.test(
      value,
    )
  ) {
    return 3;
  }
  if (/\bradeon\b/i.test(value)) return 2;
  if (/amd|advanced micro devices|ven_1002/i.test(value)) return 1;
  return 0;
}

function compareAmdGpuPriority(
  left: DetectedGpuInfo,
  right: DetectedGpuInfo,
): number {
  const leftAdapterClass = resolveAmdAdapterClassPriority(left.name);
  const rightAdapterClass = resolveAmdAdapterClassPriority(right.name);
  if (leftAdapterClass !== rightAdapterClass) {
    return rightAdapterClass - leftAdapterClass;
  }
  const leftRocm = resolveAmdRocmTargetFromInfo(left) ? 1 : 0;
  const rightRocm = resolveAmdRocmTargetFromInfo(right) ? 1 : 0;
  if (leftRocm !== rightRocm) return rightRocm - leftRocm;
  const memoryDifference = (right.memoryMb ?? 0) - (left.memoryMb ?? 0);
  if (memoryDifference !== 0) return memoryDifference;
  return String(left.name ?? "").localeCompare(String(right.name ?? ""));
}

function resolveAmdAdapterClassPriority(
  name: string | null | undefined,
): number {
  const normalized = String(name ?? "")
    .toLowerCase()
    .replace(/[™®]/g, " ");
  if (
    /\brx\s*\d{3,4}(?:\s*(?:xtx?|gre|m(?:\s*xt)?|s))?\b|\bradeon\s+pro\s+[wv]\s*\d+\b|\bpro\s+v\s*\d+\b|\binstinct\b|\bmi\s*\d+\b/.test(
      normalized,
    )
  ) {
    return 2;
  }
  if (
    /\bryzen\b|\bradeon\s+(?:\d{3,4}[ms])\b|\bradeon(?:\(tm\))?\s+graphics\b/.test(
      normalized,
    )
  ) {
    return 0;
  }
  return 1;
}
