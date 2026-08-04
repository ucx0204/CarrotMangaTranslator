import type { RankedFontCandidateV2 } from "../../shared/fontMatchingProfileTypes";

/**
 * Output rows retained only to preserve sealed model/catalog compatibility.
 * They must never reach a user-visible font choice or rendered page.
 */
export const RETIRED_AUTOMATIC_FONT_IDS = new Set(["gugi"]);

export function markRetiredAutomaticFontCandidates(
  candidates: readonly RankedFontCandidateV2[],
): RankedFontCandidateV2[] {
  return candidates.map((candidate) =>
    RETIRED_AUTOMATIC_FONT_IDS.has(candidate.fontId)
      ? {
          ...candidate,
          renderStatus: "unrenderable" as const,
          unrenderableReason: "font_retired_by_product_policy",
          confidence: 0,
          reasonCodes: [
            ...new Set([
              ...candidate.reasonCodes,
              "font_retired_by_product_policy",
            ]),
          ],
        }
      : candidate,
  );
}
