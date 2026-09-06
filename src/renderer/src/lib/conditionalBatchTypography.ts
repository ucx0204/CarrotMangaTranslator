import type { ConditionalBatchEngineOptions } from "../../../shared/conditionalBatchEngine";
import type {
  ConditionalBatchActionV2,
  ConditionalBatchSchemeDraftV2,
} from "../../../shared/conditionalBatchRules";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import { parseRichText } from "../../../shared/richTextMarkup";
import type { TranslationBlock } from "../../../shared/textTypes";
import { resolveBlockFontSizeAtNaturalPageScale } from "./blockFontSizeAdjustment";
import type { BlockFontCatalog } from "./fonts";
import { resolvePageSourceFontFaceFallbacks } from "./sourceFontSizeMatching";
import { createBlockFontLoadKey } from "./blockFontLoading";

/** Include intermediate faces before conditions measure a sequence's output. */
export function createConditionalBatchTypographyLoadKey(
  chapter: ChapterSnapshot,
  schemes: readonly ConditionalBatchSchemeDraftV2[],
  catalog: BlockFontCatalog,
): string {
  return createBlockFontLoadKey(
    typographyLoadBlocks(chapter, schemes),
    catalog,
  );
}

function* typographyLoadBlocks(
  chapter: ChapterSnapshot,
  schemes: readonly ConditionalBatchSchemeDraftV2[],
): Generator<TranslationBlock> {
  const fontIds = new Set<string | undefined>();
  const blocks = chapter.pages.flatMap((page) => page.blocks);
  const template = blocks[0];
  yield* blocks;
  for (const block of blocks) {
    fontIds.add(block.fontFamily);
    for (const text of [block.translatedText, block.sourceText]) {
      for (const run of parseRichText(text).runs) {
        fontIds.add(run.fontFamily ?? block.fontFamily);
      }
    }
  }
  if (!template) return;
  for (const scheme of schemes) {
    for (const action of scheme.actions.filter((entry) => entry.enabled)) {
      for (const id of actionFontIds(action)) fontIds.add(id);
    }
  }
  for (const fontFamily of fontIds) {
    for (const bold of [false, true]) {
      for (const italic of [false, true]) {
        yield {
          ...template,
          translatedText: "Aa가나다漢字かな",
          fontFamily,
          bold,
          italic,
        };
      }
    }
  }
}

function* actionFontIds(
  action: ConditionalBatchActionV2,
): Generator<string | undefined> {
  if (action.type === "styleText") {
    if (action.patch.fontFamily) yield action.patch.fontFamily;
  } else if (action.type === "applyStylePreset") {
    yield action.format.fontFamily;
  } else if (action.type === "setFields") {
    for (const change of action.changes) {
      yield* fieldChangeFontIds(change);
    }
  }
}

function* fieldChangeFontIds(
  change: Extract<
    ConditionalBatchActionV2,
    { type: "setFields" }
  >["changes"][number],
): Generator<string | undefined> {
  if (change.field === "fontFamily") {
    yield change.operation === "set" && typeof change.value === "string"
      ? change.value
      : undefined;
  } else if (
    (change.field === "translatedText" || change.field === "sourceText") &&
    typeof change.value === "string"
  ) {
    for (const run of parseRichText(change.value).runs) {
      if (run.fontFamily) yield run.fontFamily;
    }
  }
}

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
