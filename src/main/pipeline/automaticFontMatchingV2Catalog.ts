import { createHash } from "node:crypto";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";

const CATALOG_SCHEMA_VERSION = "built-in-render-bank-v2";
const RENDERER_CONTRACT_VERSION =
  "chromium-css-font-renderer-v2:font-face-manifest-v2";

export const FONT_MATCHING_V2_MODEL_VERSION = "semantic-bootstrap-v2";
export const FONT_MATCHING_V2_RENDERER_HASH = createHash("sha256")
  .update(RENDERER_CONTRACT_VERSION)
  .digest("hex");

/**
 * Profiles are tied to the exact built-in render bank visible to this job.
 * Custom fonts and favorite/default ordering are excluded: custom lock
 * availability is checked per candidate, while preferences are not face
 * compatibility.
 */
export function resolveFontMatchingV2CatalogVersion(
  candidates: readonly AutomaticFontCandidate[],
): string {
  const manifest = [...candidates]
    .filter((candidate) => candidate.source === "built-in")
    .sort((left, right) => compareStrings(left.fontId, right.fontId))
    .map((candidate) => ({
      source: candidate.source,
      fontId: candidate.fontId,
      supportedLocales: [...candidate.supportedLocales].sort(compareStrings),
      unicodeRanges: [...candidate.unicodeRanges]
        .map(([start, end]) => [start, end] as const)
        .sort((left, right) => left[0] - right[0] || left[1] - right[1]),
      weight: candidate.weight,
      width: candidate.width,
      italic: candidate.italic,
      serif: candidate.serif ?? null,
    }));
  const digest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex")
    .slice(0, 20);
  return `${CATALOG_SCHEMA_VERSION}:${digest}`;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
