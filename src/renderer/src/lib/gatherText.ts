import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { TFunction } from "i18next";

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
  includeHeaders = true,
): string {
  const chunks: string[] = [];
  for (const page of pages) {
    if (page.blocks.length === 0) {
      continue;
    }
    const lines: string[] = includeHeaders
      ? [`# ${page.index + 1}쪽 · ${page.pageName}`]
      : [];
    for (const block of page.blocks) {
      lines.push(...formatBlockLines(block, field));
    }
    chunks.push(lines.join("\n").trimEnd());
  }
  return chunks.join("\n\n");
}

export function decodeImportedTextContent(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (_error) {
    return new TextDecoder("windows-949").decode(buffer);
  }
}

export type TranslatedTextImportUpdate = {
  pageId: string;
  blockId: string;
  translatedText: string;
};

export type TranslatedTextImportResult = {
  updates: TranslatedTextImportUpdate[];
  matchedPageCount: number;
  warnings: string[];
};

type ParsedTextSection = {
  pageNumber: number | null;
  pageName: string | null;
  lines: string[];
  groups: string[][];
};

const IMPORT_FALLBACKS = {
  noText: "불러온 파일에 텍스트가 없습니다.",
  missingHeaders:
    "페이지 머리말(# n쪽)이 없어 어느 페이지의 텍스트인지 알 수 없습니다. 머리말을 포함해 저장한 txt를 사용하세요.",
  pageNumber: "{{number}}쪽",
  headerlessSection: "머리말 없는 구간",
  pageMissing: "{{page}}: 해당 페이지를 찾을 수 없어 건너뜁니다.",
  blockMismatch:
    "{{page}}쪽: 텍스트 줄 구성과 번역 블록 {{count}}개가 맞지 않아 건너뜁니다.",
} as const;

/** Matches the exported page header, e.g. `# 3쪽 · page-003.png`. */
const PAGE_HEADER_PATTERN = /^#\s*(\d+)\s*쪽(?:\s*·\s*(.*))?$/;

function parseTextSections(content: string): {
  sections: ParsedTextSection[];
  hasHeaders: boolean;
} {
  const sections: ParsedTextSection[] = [];
  let current: ParsedTextSection | null = null;
  let currentGroup: string[] = [];
  let hasHeaders = false;

  const flushGroup = (): void => {
    if (current && currentGroup.length > 0) {
      current.groups.push(currentGroup);
    }
    currentGroup = [];
  };

  const startSection = (
    pageNumber: number | null,
    pageName: string | null,
  ): ParsedTextSection => {
    flushGroup();
    const section = { pageNumber, pageName, lines: [], groups: [] };
    sections.push(section);
    current = section;
    return section;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = PAGE_HEADER_PATTERN.exec(line);
    if (header) {
      hasHeaders = true;
      startSection(Number(header[1]), header[2]?.trim() || null);
      continue;
    }
    if (!line) {
      flushGroup();
      continue;
    }
    const section = current ?? startSection(null, null);
    section.lines.push(line);
    currentGroup.push(line);
  }
  flushGroup();
  return { sections, hasHeaders };
}

function resolveSectionPage(
  section: ParsedTextSection,
  pages: GatheredPage[],
): GatheredPage | null {
  if (section.pageNumber !== null) {
    const targetIndex = section.pageNumber - 1;
    const byIndex = pages.find((page) => page.index === targetIndex);
    if (byIndex) {
      return byIndex;
    }
    if (section.pageName) {
      return pages.find((page) => page.pageName === section.pageName) ?? null;
    }
    return null;
  }
  return pages.length === 1 ? pages[0] : null;
}

/**
 * Matches a .txt export back onto the gathered pages. It accepts both the
 * default OCR + translation export and the translation-only export, in reading order,
 * optionally grouped under `# n쪽 · 이름` headers. Pages whose text shape no
 * longer matches the block list are skipped with a warning instead of guessing.
 */
export function buildTranslatedTextImport(
  pages: GatheredPage[],
  content: string,
  t?: TFunction<"renderer">,
): TranslatedTextImportResult {
  const { sections, hasHeaders } = parseTextSections(content);
  const warnings: string[] = [];
  const updates: TranslatedTextImportUpdate[] = [];
  let matchedPageCount = 0;

  if (sections.length === 0) {
    return {
      updates,
      matchedPageCount,
      warnings: [importMessage(t, "noText")],
    };
  }
  if (!hasHeaders && pages.length !== 1) {
    return {
      updates,
      matchedPageCount,
      warnings: [importMessage(t, "missingHeaders")],
    };
  }

  for (const section of sections) {
    const page = resolveSectionPage(section, pages);
    if (!page) {
      warnings.push(
        importMessage(t, "pageMissing", {
          page:
            section.pageNumber !== null
              ? importMessage(t, "pageNumber", {
                  number: section.pageNumber,
                })
              : importMessage(t, "headerlessSection"),
        }),
      );
      continue;
    }
    const importedTexts = resolveImportedTranslatedTexts(section, page);
    if (!importedTexts) {
      warnings.push(
        importMessage(t, "blockMismatch", {
          page: page.index + 1,
          count: page.blocks.length,
        }),
      );
      continue;
    }
    matchedPageCount += 1;
    importedTexts.forEach((line, index) => {
      const block = page.blocks[index];
      if (line !== block.translatedText) {
        updates.push({
          pageId: page.pageId,
          blockId: block.id,
          translatedText: line,
        });
      }
    });
  }
  return { updates, matchedPageCount, warnings };
}

function importMessage(
  t: TFunction<"renderer"> | undefined,
  key: keyof typeof IMPORT_FALLBACKS,
  values?: Record<string, string | number>,
): string {
  if (t) {
    return t(`gatherText.import.${key}`, values);
  }
  return Object.entries(values ?? {}).reduce(
    (message, [name, value]) =>
      message.replaceAll(`{{${name}}}`, String(value)),
    IMPORT_FALLBACKS[key] as string,
  );
}

function resolveImportedTranslatedTexts(
  section: ParsedTextSection,
  page: GatheredPage,
): string[] | null {
  return (
    resolveBothFieldGroups(section, page) ??
    resolveTranslatedFieldLines(section.lines, page) ??
    resolveBothFieldLines(section.lines, page)
  );
}

function resolveBothFieldGroups(
  section: ParsedTextSection,
  page: GatheredPage,
): string[] | null {
  if (section.groups.length !== page.blocks.length) {
    return null;
  }
  const texts: string[] = [];
  for (const [index, group] of section.groups.entries()) {
    const sourceLines = splitMeaningfulLines(page.blocks[index]?.sourceText);
    if (!startsWithLines(group, sourceLines)) {
      return null;
    }
    const translatedLines = group.slice(sourceLines.length);
    if (translatedLines.length === 0) {
      return null;
    }
    texts.push(translatedLines.join("\n"));
  }
  return texts;
}

function resolveTranslatedFieldLines(
  lines: string[],
  page: GatheredPage,
): string[] | null {
  if (lines.length === page.blocks.length) {
    return [...lines];
  }

  const texts: string[] = [];
  let cursor = 0;
  for (const block of page.blocks) {
    const lineCount = Math.max(
      1,
      splitMeaningfulLines(block.translatedText).length,
    );
    const nextLines = lines.slice(cursor, cursor + lineCount);
    if (nextLines.length !== lineCount) {
      return null;
    }
    texts.push(nextLines.join("\n"));
    cursor += lineCount;
  }
  return cursor === lines.length ? texts : null;
}

function resolveBothFieldLines(
  lines: string[],
  page: GatheredPage,
): string[] | null {
  const texts: string[] = [];
  let cursor = 0;
  for (const block of page.blocks) {
    const sourceLines = splitMeaningfulLines(block.sourceText);
    if (sourceLines.length > 0) {
      const candidateSource = lines.slice(cursor, cursor + sourceLines.length);
      if (!areSameLines(candidateSource, sourceLines)) {
        return null;
      }
      cursor += sourceLines.length;
    }
    const translatedLine = lines[cursor];
    if (translatedLine === undefined) {
      return null;
    }
    texts.push(translatedLine);
    cursor += 1;
  }
  return cursor === lines.length ? texts : null;
}

function splitMeaningfulLines(text: string | undefined): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function startsWithLines(lines: string[], prefix: string[]): boolean {
  if (prefix.length === 0) {
    return true;
  }
  return areSameLines(lines.slice(0, prefix.length), prefix);
}

function areSameLines(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}
