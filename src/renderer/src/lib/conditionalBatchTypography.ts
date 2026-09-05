import type { ConditionalBatchEngineOptions } from "../../../shared/conditionalBatchEngine";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import { resolveBlockFontSizeAtNaturalPageScale } from "./blockFontSizeAdjustment";
import type { BlockFontCatalog } from "./fonts";
import { resolvePageSourceFontFaceFallbacks } from "./sourceFontSizeMatching";

/** Measure the same natural-page pixels as the canvas and format inspector. */
export function createConditionalBatchFontSizeResolver(
  catalog: BlockFontCatalog,
): NonNullable<ConditionalBatchEngineOptions["resolveFontSizePx"]> {
  const pages = new WeakMap<
    MangaPage,
    {
      fallbacks: ReadonlyMap<string, number>;
      sizes: WeakMap<TranslationBlock, number>;
    }
  >();
  return (block, page) => {
    let cached = pages.get(page);
    if (!cached) {
      cached = {
        fallbacks: resolvePageSourceFontFaceFallbacks(page.blocks, page),
        sizes: new WeakMap(),
      };
      pages.set(page, cached);
    }
    const previous = cached.sizes.get(block);
    if (previous !== undefined) return previous;
    const size = resolveBlockFontSizeAtNaturalPageScale(
      block,
      page,
      catalog,
      cached.fallbacks.get(block.id),
    );
    cached.sizes.set(block, size);
    return size;
  };
}
