// @ts-check

const MAX_VISUAL_CLUSTER_ID_LENGTH = 200;
const UNSAFE_VISUAL_CLUSTER_ID_CHARACTERS =
  /[\\/\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** @param {unknown} value @returns {string | undefined} */
function normalizeVisualClusterId(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  if (
    !normalized ||
    normalized.length > MAX_VISUAL_CLUSTER_ID_LENGTH ||
    normalized === "." ||
    normalized === ".." ||
    UNSAFE_VISUAL_CLUSTER_ID_CHARACTERS.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

module.exports = {
  MAX_VISUAL_CLUSTER_ID_LENGTH,
  normalizeVisualClusterId,
};
