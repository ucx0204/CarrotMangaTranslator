import { parseRocmArch, resolveAmdRocmTargetFromInfo } from "../amdRocmTargets";
import type { DetectedGpuInfo } from "../gpuInfo";

/**
 * AMD HIP SDK for Windows 7.2 hardware matrix used by Flux ZLUDA. This is
 * deliberately separate from the packaged PyTorch ROCm OCR matrix: the two
 * runtimes publish different support lists.
 */
const SUPPORTED_WINDOWS_HIP_SDK_ARCHES = new Set([
  "gfx1100",
  "gfx1101",
  "gfx1102",
  "gfx1150",
  "gfx1151",
  "gfx1200",
  "gfx1201",
]);

const SUPPORTED_WINDOWS_HIP_SDK_NAME_PATTERNS: RegExp[] = [
  // RDNA 4 Radeon and Radeon PRO.
  /\b(?:radeon\s+)?rx\s*9070(?:\s*(?:xt|gre))?\b/,
  /\b(?:radeon\s+)?rx\s*9060(?:\s*xt)?\b/,
  /\b(?:radeon\s+)?(?:ai\s+)?pro\s+r\s*9700\b/,
  // RDNA 3 desktop Radeon. RX 7700S and unlisted workstation variants are
  // intentionally not covered.
  /\b(?:radeon\s+)?rx\s*7900(?:\s*(?:xtx|xt))?\b/,
  /\b(?:radeon\s+)?rx\s*7800\s*xt\b/,
  /\b(?:radeon\s+)?rx\s*7700\s*xt\b/,
  /\b(?:radeon\s+)?rx\s*7650\s*gre\b/,
  /\b(?:radeon\s+)?rx\s*7600(?:\s*xt)?\b/,
  /\b(?:radeon\s+)?pro\s+w(?:7700|7800|7900)(?:\s+dual\s+slot)?\b/,
  // RDNA 3.5 APUs in the current Windows HIP SDK table.
  /\bryzen\s+ai\s+(?:9\s+)?(?:300|400)\s+series\b/,
  /\bryzen\s+ai\s+9\s+(?:hx\s*37[05]|365)\b/,
  /\bryzen\s+ai\s+max(?:\+)?(?:\s+pro)?\s+(?:380|385|390|395|490|492|495)\b/,
];

const KNOWN_UNSUPPORTED_WINDOWS_HIP_SDK_NAME_PATTERNS: RegExp[] = [
  /\b(?:radeon\s+)?rx\s*6\d{3}(?:\s*(?:xt|m|s))?\b/,
  /\b(?:radeon\s+)?rx\s*7700s\b/,
  /\b(?:radeon\s+)?pro\s+(?:w(?:5500|6600|6800|7500|7600)|vii)\b/,
  /\bradeon\s+(?:740m|760m|780m)\b/,
];

/**
 * `true`/`false` means the detected model can be classified against AMD's
 * current official Windows HIP SDK table. `undefined` means the adapter name
 * is too vague to make a safe claim, so the UI avoids a false warning.
 */
export function resolveWindowsHipSdkGpuSupport(
  info: DetectedGpuInfo | null,
): boolean | undefined {
  if (!info || info.vendor !== "amd") return undefined;
  const archSupport = resolveArchSupport(info.rocmArch);
  if (archSupport !== undefined) return archSupport;
  const nameSupport = resolveNameSupport(info.name);
  if (nameSupport !== undefined) return nameSupport;
  return resolveTargetSupport(resolveAmdRocmTargetFromInfo(info));
}

function resolveArchSupport(
  rawArch: string | null | undefined,
): boolean | undefined {
  const arch = parseRocmArch(String(rawArch ?? ""));
  if (!arch) return undefined;
  const baseArch = arch.match(/^gfx[0-9a-f]+/)?.[0] ?? arch;
  return SUPPORTED_WINDOWS_HIP_SDK_ARCHES.has(baseArch);
}

function resolveNameSupport(
  rawName: string | null | undefined,
): boolean | undefined {
  const name = String(rawName ?? "")
    .toLowerCase()
    .replace(/[™®]/g, " ")
    .trim();
  if (!name) return undefined;
  if (matchesAny(name, SUPPORTED_WINDOWS_HIP_SDK_NAME_PATTERNS)) return true;
  if (matchesAny(name, KNOWN_UNSUPPORTED_WINDOWS_HIP_SDK_NAME_PATTERNS)) {
    return false;
  }
  return undefined;
}

function resolveTargetSupport(
  target: ReturnType<typeof resolveAmdRocmTargetFromInfo>,
): boolean | undefined {
  if (!target) return undefined;
  if (target === "gfx1150" || target === "gfx1151" || target === "gfx120X") {
    return true;
  }
  // Known AMD models/architectures absent from the official table are marked
  // unsupported instead of being routed into an expected runtime failure.
  return false;
}

function matchesAny(name: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(name));
}
