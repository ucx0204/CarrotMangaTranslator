import type { TranslationBlock } from "../../../shared/textTypes";

const AUTOMATIC_FONT_STYLE_KEYS: ReadonlySet<keyof TranslationBlock> = new Set([
  "fontFamily",
  "bold",
  "italic",
  "textColor",
  "outlineColor",
  "outlineWidthScale",
]);

/** Manual edits to an automatically-owned style cannot retain stale rollback. */
export function clearAutomaticFontMatchForManualStylePatch(
  block: TranslationBlock,
  patch: Partial<TranslationBlock>,
): Partial<TranslationBlock> {
  if (
    !block.automaticFontMatch ||
    Object.hasOwn(patch, "automaticFontMatch") ||
    !(Object.keys(patch) as Array<keyof TranslationBlock>).some((key) =>
      AUTOMATIC_FONT_STYLE_KEYS.has(key),
    )
  ) {
    return patch;
  }
  return { ...patch, automaticFontMatch: undefined };
}
