import type { TranslationBlock } from "./textTypes";

export function getActiveGeneratedLettering(
  block: Pick<
    TranslationBlock,
    "sourceText" | "translatedText" | "generatedLettering"
  >,
): TranslationBlock["generatedLettering"] | null {
  const artwork = block.generatedLettering;
  return artwork &&
    artwork.enabled !== false &&
    artwork.translatedText === block.translatedText &&
    artwork.sourceText === block.sourceText
    ? artwork
    : null;
}
