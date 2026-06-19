import type {
  ChapterSnapshot,
  MangaPage,
  TranslationBlock,
} from "../../../shared/types";

export type GatherScope = "page" | "chapter";
export type GatherField = "both" | "translated" | "source";
export type ReadingDirection = "rtl" | "ltr";

export type GatheredBlock = {
  id: string;
  translatedText: string;
  sourceText: string;
};

export type GatheredPage = {
  pageId: string;
  pageName: string;
  /** Zero-based index within the chapter (header shows index + 1). */
  index: number;
  blocks: GatheredBlock[];
};

/**
 * Orders blocks for natural reading. Blocks are grouped into rows top-to-bottom
 * (by vertical overlap), then sorted within each row horizontally. Default is
 * `rtl` (right-to-left) to match Japanese manga; pass `ltr` to flip it.
 */
export function sortBlocksForReading(
  blocks: TranslationBlock[],
  direction: ReadingDirection = "rtl",
): TranslationBlock[] {
  const items = [...blocks];
  if (items.length <= 1) {
    return items;
  }
  items.sort((a, b) => a.bbox.y - b.bbox.y);

  const rows: TranslationBlock[][] = [];
  for (const block of items) {
    const row = rows[rows.length - 1];
    if (row) {
      const ref = row[0];
      const refCenter = ref.bbox.y + ref.bbox.h / 2;
      const blockCenter = block.bbox.y + block.bbox.h / 2;
      const threshold = Math.max(ref.bbox.h, block.bbox.h) * 0.5;
      if (Math.abs(blockCenter - refCenter) <= threshold) {
        row.push(block);
        continue;
      }
    }
    rows.push([block]);
  }

  for (const row of rows) {
    row.sort((a, b) =>
      direction === "rtl" ? b.bbox.x - a.bbox.x : a.bbox.x - b.bbox.x,
    );
  }
  return rows.flat();
}

/**
 * Collects the (reading-ordered, non-empty) text of either the current page or
 * the whole chapter, grouped per page.
 */
export function gatherText(input: {
  chapter: ChapterSnapshot | null;
  page: MangaPage | null;
  scope: GatherScope;
  direction?: ReadingDirection;
}): GatheredPage[] {
  const direction = input.direction ?? "rtl";
  const chapterPages = input.chapter?.pages ?? [];

  let targets: { page: MangaPage; index: number }[];
  if (input.scope === "chapter") {
    targets = chapterPages.map((page, index) => ({ page, index }));
  } else if (input.page) {
    const found = chapterPages.findIndex((page) => page.id === input.page?.id);
    targets = [{ page: input.page, index: found >= 0 ? found : 0 }];
  } else {
    targets = [];
  }

  return targets.map(({ page, index }) => {
    const blocks = sortBlocksForReading(page.blocks, direction)
      .map((block) => ({
        id: block.id,
        translatedText: block.translatedText.trim(),
        sourceText: block.sourceText.trim(),
      }))
      .filter((block) => block.translatedText || block.sourceText);
    return { pageId: page.id, pageName: page.name, index, blocks };
  });
}

/**
 * Drops blocks (and then empty pages) that have no text for the chosen field,
 * so the single-field views don't render empty cards / page headers.
 */
export function filterPagesByField(
  pages: GatheredPage[],
  field: GatherField,
): GatheredPage[] {
  if (field === "both") {
    return pages.filter((page) => page.blocks.length > 0);
  }
  const key = field === "translated" ? "translatedText" : "sourceText";
  return pages
    .map((page) => ({
      ...page,
      blocks: page.blocks.filter((block) => block[key]),
    }))
    .filter((page) => page.blocks.length > 0);
}

/**
 * Serializes gathered pages to plain text for clipboard or .txt export. `both`
 * pairs OCR + translation per block; the single-field modes emit just one side.
 */
function formatBlockLines(block: GatheredBlock, field: GatherField): string[] {
  if (field === "translated") {
    return block.translatedText ? [block.translatedText] : [];
  }
  if (field === "source") {
    return block.sourceText ? [block.sourceText] : [];
  }
  const lines: string[] = [];
  if (block.sourceText) {
    lines.push(block.sourceText);
  }
  if (block.translatedText) {
    lines.push(block.translatedText);
  }
  // Trailing blank line separates OCR/translation pairs in the combined view.
  lines.push("");
  return lines;
}

export function formatGatheredText(
  pages: GatheredPage[],
  field: GatherField,
): string {
  const chunks: string[] = [];
  for (const page of pages) {
    if (page.blocks.length === 0) {
      continue;
    }
    const lines: string[] = [`# ${page.index + 1}쪽 · ${page.pageName}`];
    for (const block of page.blocks) {
      lines.push(...formatBlockLines(block, field));
    }
    chunks.push(lines.join("\n").trimEnd());
  }
  return chunks.join("\n\n");
}
