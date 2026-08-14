import { canonicalizeAmdRocmTarget } from "../shared/settingsAliasCanonicalizers";
import type { AmdRocmTarget } from "../shared/settingsTypes";

type RocmTargetInfo = {
  name: string | null;
  rocmArch?: string | null;
  rocmTarget?: AmdRocmTarget | null;
};

const AMD_NAME_TARGET_PATTERNS: Array<{
  target: AmdRocmTarget;
  patterns: RegExp[];
}> = [
  {
    target: "gfx908",
    patterns: [/\bmi\s*100\b|\binstinct\s+mi100\b/],
  },
  {
    target: "gfx90a",
    patterns: [/\bmi\s*(200|210|250)\b|\binstinct\s+mi(200|210|250)\b/],
  },
  {
    target: "gfx120X",
    patterns: [
      /\b(?:amd\s+)?(?:radeon\s+)?(?:ai\s+)?pro\s+r\s*9700\b/,
      /\b(rx\s*)?90(60|70)\b|\b(rx\s*)?90(60|70)\s*(xt|gre)\b/,
    ],
  },
  {
    target: "gfx110X",
    patterns: [
      /\b(?:amd\s+)?(?:radeon\s+)?(?:pro\s+)?v\s*710(?:\s*mxgpu)?(?:[-\s]\d+q)?\b/,
      /\bven_1002&dev_746[01]\b/,
      /\bven_1002&dev_7480\b/,
      /\b(rx\s*)?7(600|650|700|800|900)\b|\b(rx\s*)?7(600|650|700|800|900)\s*(xt|xtx|gre)\b/,
      /\b(?:radeon\s+)?(?:pro\s*)?w7(500|600|700|800|900)\b/,
      /\bradeon\s+(740m|760m|780m)\b/,
    ],
  },
  {
    target: "gfx103X",
    patterns: [
      /\b(?:radeon\s+)?pro\s+(v\s*620|w\s*(6600|6800))\b/,
      /\b(rx\s*)?6(400|500|600|650|700|750|800|900|950)\b|\b(rx\s*)?6(400|500|600|650|700|750|800|900|950)\s*(xt|m|s)\b/,
    ],
  },
  {
    target: "gfx1151",
    patterns: [/\bryzen\s+ai\s+max\b|\bstrix\s+halo\b|\bradeon\s+80(50|60)s\b/],
  },
  {
    target: "gfx1150",
    patterns: [
      /\bryzen\s+ai\s+9\s+(hx\s*37(0|5)|365)\b|\bradeon\s+(880m|890m)\b/,
    ],
  },
];

export function parseRocmArch(value: string): string | null {
  const match = value.match(/\bgfx[0-9a-f]+(?:[:_a-z0-9.-]*)?\b/i);
  return match ? match[0].toLowerCase() : null;
}

export function normalizeAmdRocmTarget(value: unknown): AmdRocmTarget | null {
  return canonicalizeAmdRocmTarget(value) ?? null;
}

export function resolveAmdRocmTargetFromArch(
  arch: string | null | undefined,
): AmdRocmTarget | null {
  return normalizeAmdRocmTarget(parseRocmArch(String(arch ?? "")) ?? arch);
}

export function inferAmdRocmTargetFromName(
  name: string | null | undefined,
): AmdRocmTarget | null {
  const normalized = normalizeGpuNameForRocmTarget(name);
  if (!normalized) {
    return null;
  }
  return matchAmdNameTarget(normalized);
}

export function resolveAmdRocmTargetFromInfo(
  info: RocmTargetInfo | null | undefined,
): AmdRocmTarget | null {
  return (
    normalizeAmdRocmTarget(info?.rocmTarget) ??
    resolveAmdRocmTargetFromArch(info?.rocmArch) ??
    inferAmdRocmTargetFromName(info?.name)
  );
}

function normalizeGpuNameForRocmTarget(
  name: string | null | undefined,
): string | null {
  const normalized = String(name ?? "")
    .toLowerCase()
    .replace(/[™®]/g, " ");
  return normalized.trim() ? normalized : null;
}

function matchAmdNameTarget(normalized: string): AmdRocmTarget | null {
  for (const { target, patterns } of AMD_NAME_TARGET_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(normalized))) {
      return target;
    }
  }
  return null;
}
