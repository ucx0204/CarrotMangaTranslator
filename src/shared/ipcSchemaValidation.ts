import type { BBox } from "./textTypes";

export function isLegacyAutomaticFontMatch(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1,
  );
}

export function isJsonObjectString(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return Boolean(
      parsed && typeof parsed === "object" && !Array.isArray(parsed),
    );
  } catch (_error) {
    return false;
  }
}

export function isValidCustomHeadersJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return Object.entries(parsed).every(([key, headerValue]) => {
      if (isForbiddenCustomHeader(key)) return false;
      return ["string", "number", "boolean"].includes(typeof headerValue);
    });
  } catch (_error) {
    return false;
  }
}

function isForbiddenCustomHeader(name: string): boolean {
  return [
    "authorization",
    "content-type",
    "host",
    "content-length",
    "cookie",
    "set-cookie",
  ].includes(name.trim().toLowerCase());
}

export function clampNormalizedBbox(bbox: BBox): BBox {
  const x = Math.min(999, Math.max(0, bbox.x));
  const y = Math.min(999, Math.max(0, bbox.y));
  const w = Math.min(1000 - x, Math.max(1, bbox.w));
  const h = Math.min(1000 - y, Math.max(1, bbox.h));
  return { x, y, w, h };
}
