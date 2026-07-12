// @ts-check
const { toNumber } = require("./overlay-geometry.cjs");

const TEXT_ROLE_ALIASES = Object.freeze({
  sound: new Set([
    "sound",
    "sfx",
    "soundeffect",
    "effect",
    "reaction",
    "onomatopoeia",
  ]),
  ordinary: new Set([
    "ordinary",
    "speech",
    "dialogue",
    "dialog",
    "bubble",
    "caption",
    "narration",
    "label",
    "sign",
    "note",
    "title",
  ]),
  nontext: new Set([
    "nontext",
    "nottext",
    "reject",
    "decoration",
    "texture",
    "ornament",
  ]),
});

/** @param {unknown} value @returns {"horizontal" | "vertical"} */
function normalizeDirection(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text === "vertical" ? "vertical" : "horizontal";
}

/** @param {unknown} value @returns {"" | "sound" | "ordinary" | "nontext"} */
function normalizeTextRole(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  for (const [role, aliases] of Object.entries(TEXT_ROLE_ALIASES)) {
    if (aliases.has(text)) {
      return /** @type {"sound" | "ordinary" | "nontext"} */ (role);
    }
  }
  return "";
}

/** @param {unknown} value */
function normalizeAngle(value) {
  const parsed = toNumber(value);
  return parsed === null ? 0 : Math.min(30, Math.max(-30, Math.round(parsed)));
}

/** @param {unknown} value */
function normalizeFontSize(value) {
  const parsed = toNumber(value);
  return parsed === null
    ? null
    : Math.min(160, Math.max(6, Math.round(parsed)));
}

/** @param {unknown} value */
function normalizeConfidence(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = toNumber(value);
  if (parsed === null) {
    return null;
  }
  const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return Math.min(1, Math.max(0, normalized));
}

/** @param {unknown} value @returns {"reject" | "nonsolid"} */
function normalizeParsedType(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase() === "reject"
    ? "reject"
    : "nonsolid";
}

/** @param {unknown} value */
function normalizeTextField(value) {
  return String(value ?? "")
    .replace(/\\n/g, "\n")
    .trim();
}

/** @param {unknown} value */
function isPlaceholderOnly(value) {
  const compact = String(value ?? "").replace(/\s+/g, "");
  return compact === "[?]" || compact === "？" || compact === "?";
}

module.exports = {
  isPlaceholderOnly,
  normalizeAngle,
  normalizeConfidence,
  normalizeDirection,
  normalizeFontSize,
  normalizeParsedType,
  normalizeTextField,
  normalizeTextRole,
};
