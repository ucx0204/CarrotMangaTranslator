import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFontCatalog } from "./fonts";
import { resolveBlockTextLayout } from "./overlayLayout";
import { resolvePageSourceFontFaceFallbacks } from "./sourceFontSizeMatching";
import {
  FONT_SIZE_STEP_PX,
  clampFontSizePx,
} from "../../../shared/blockFormatValues";

export type FontSizeAdjustment = -1 | 1;

/**
 * Applies a relative font-size edit against the supplied (latest) chapter.
 * Returning the same object for a missing target or a no-op bound prevents an
 * empty history entry from being recorded by useCurrentChapterUpdater.
 */
export function adjustBlockFontSizeInChapter(
  chapter: ChapterSnapshot,
  pageId: string,
  blockId: string,
  adjustment: FontSizeAdjustment,
  fontCatalog: BlockFontCatalog,
): ChapterSnapshot {
  const targetPage = chapter.pages.find((page) => page.id === pageId);
  if (!targetPage) {
    return chapter;
  }

  let changed = false;
  const blocks = targetPage.blocks.map((block) => {
    if (block.id !== blockId) {
      return block;
    }
    const next = adjustBlockFontSize(
      block,
      targetPage,
      adjustment,
      fontCatalog,
    );
    changed ||= next !== block;
    return next;
  });
  if (!changed) {
    return chapter;
  }

  return {
    ...chapter,
    pages: chapter.pages.map((page) =>
      page.id === pageId
        ? { ...page, blocks, updatedAt: new Date().toISOString() }
        : page,
    ),
  };
}

function adjustBlockFontSize(
  block: TranslationBlock,
  page: MangaPage,
  adjustment: FontSizeAdjustment,
  fontCatalog: BlockFontCatalog,
): TranslationBlock {
  const autoFitText = block.autoFitText ?? true;
  const baseFontSize = autoFitText
    ? resolveAutoFitFontSizeAtNaturalPageScale(block, page, fontCatalog)
    : block.fontSizePx;
  const fontSizePx = clampFontSizePx(
    baseFontSize + adjustment * FONT_SIZE_STEP_PX,
  );
  if (!autoFitText && fontSizePx === block.fontSizePx) {
    return block;
  }
  return { ...block, autoFitText: false, fontSizePx };
}

function resolveAutoFitFontSizeAtNaturalPageScale(
  block: TranslationBlock,
  page: MangaPage,
  fontCatalog: BlockFontCatalog,
): number {
  const displayText = block.translatedText || block.sourceText || "...";
  const naturalPageSize = { width: page.width, height: page.height };
  const sourceFontFaceFallbackPx = resolvePageSourceFontFaceFallbacks(
    page.blocks,
    naturalPageSize,
  ).get(block.id);
  return resolveBlockTextLayout(
    block,
    displayText,
    naturalPageSize,
    naturalPageSize,
    fontCatalog,
    { sourceFontFaceFallbackPx },
  ).fontSizePx;
}
