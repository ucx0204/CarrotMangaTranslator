import { normalizeBboxTo1000 } from "../../shared/geometry";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { OverlayItem } from "../pipeline/types";

/** Shared original-image geometry and text projection for independent observations. */
export function mcpSourceTypographyItem(
  page: MangaPage,
  block: TranslationBlock,
  index: number,
): OverlayItem {
  return {
    id: index + 1,
    type: block.type,
    textRole: "ordinary",
    fontRole: block.fontRole,
    bbox: normalizeBboxTo1000(block.bbox, page, block.bboxSpace),
    jp: block.sourceText,
    ko: block.translatedText,
    sourceText: block.sourceText,
    translatedText: block.translatedText,
    direction: block.sourceDirection,
  };
}
