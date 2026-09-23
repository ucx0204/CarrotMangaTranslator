import type { TranslationBlock } from "./textTypes";

/** One policy for editable overlays and exported artwork. Empty preparation is intentional. */
export function resolveBlockDisplayText(
  block: Pick<
    TranslationBlock,
    "sourceText" | "translatedText" | "textDisplayMode"
  >,
): string {
  return block.textDisplayMode === "translation-only"
    ? block.translatedText
    : block.translatedText || block.sourceText;
}
