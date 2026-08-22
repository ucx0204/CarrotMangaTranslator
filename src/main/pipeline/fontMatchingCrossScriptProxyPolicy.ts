import type { FontMatchingPageInferenceBlock } from "./fontMatchingPagePixelInferenceTypes";

/**
 * The page voice model is for ordinary prose. Display titles and sound effects
 * intentionally stay on the existing per-block model because their font
 * changes are usually meaningful rather than accidental inconsistency.
 */
export function isCrossScriptProxyEligibleBlock(
  block: FontMatchingPageInferenceBlock,
): boolean {
  if (block.item.textRole !== "ordinary") return false;
  const role = block.item.fontRole;
  return (
    role === "dialogue" ||
    role === "narration" ||
    role === "thought" ||
    role === "whisper" ||
    role === "aside_balloon_edge" ||
    role === "emphasis_dialogue" ||
    role === "shout" ||
    role === "other"
  );
}
