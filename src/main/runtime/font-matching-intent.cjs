// @ts-check

/** Keep byte-for-byte values aligned with shared/fontMatchingProfileTypes.ts. */
const FONT_MATCHING_SEMANTIC_ROLES = Object.freeze([
  "dialogue",
  "narration",
  "thought",
  "whisper",
  "aside_balloon_edge",
  "emphasis_dialogue",
  "shout",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
  "sign_ui_title",
  "other",
  "unknown_needs_review",
]);

const FONT_MATCHING_SEMANTIC_ROLE_SET = new Set(FONT_MATCHING_SEMANTIC_ROLES);

/** @param {unknown} value */
function normalizeFontRole(value) {
  const role = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
  return FONT_MATCHING_SEMANTIC_ROLE_SET.has(role) ? role : undefined;
}

/** @param {unknown} value */
function normalizeFontRoleConfidence(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const raw = String(value).trim();
  const explicitPercent = raw.endsWith("%");
  const numeric = Number(explicitPercent ? raw.slice(0, -1).trim() : raw);
  if (explicitPercent) {
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100
      ? numeric / 100
      : undefined;
  }
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    return undefined;
  }
  return numeric;
}

/** @param {unknown} textRole @param {unknown} fontRole */
function isFontRoleCompatibleWithTextRole(textRole, fontRole) {
  const normalizedTextRole = String(textRole ?? "")
    .trim()
    .toLowerCase();
  const normalizedFontRole = normalizeFontRole(fontRole);
  if (!normalizedFontRole || normalizedFontRole === "unknown_needs_review") {
    return Boolean(normalizedFontRole);
  }
  if (normalizedTextRole !== "ordinary" && normalizedTextRole !== "sound") {
    return false;
  }
  const isSoundFontRole = normalizedFontRole.startsWith("sfx_");
  return normalizedTextRole === "sound" ? isSoundFontRole : !isSoundFontRole;
}

module.exports = {
  FONT_MATCHING_SEMANTIC_ROLES,
  isFontRoleCompatibleWithTextRole,
  normalizeFontRole,
  normalizeFontRoleConfidence,
};
