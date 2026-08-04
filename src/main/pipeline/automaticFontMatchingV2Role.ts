import type { FontMatchRolePredictionV2 } from "../../shared/fontMatchingProfileTypes";
import type { OverlayItem } from "./types";

const UNKNOWN_PIXEL_ROLE: FontMatchRolePredictionV2 = {
  primary: "unknown_needs_review",
  confidence: 0,
  alternatives: [],
};

/**
 * Automatic font routing is pixel-only. The translation model's semantic
 * fontRole fields remain available for audit/display, but never participate in
 * the automatic decision path.
 */
export function resolveCombinedAutomaticFontRole(
  _item: OverlayItem,
  pixel: FontMatchRolePredictionV2 | null,
): FontMatchRolePredictionV2 {
  return pixel ?? UNKNOWN_PIXEL_ROLE;
}
