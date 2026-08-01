export const MAX_VISUAL_CLUSTER_ID_LENGTH = 200;

const UNSAFE_VISUAL_CLUSTER_ID_CHARACTERS =
  /[\\/\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Canonicalize an optional model/user visual-cluster identifier. */
export function normalizeVisualClusterId(value: unknown): string | undefined {
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
