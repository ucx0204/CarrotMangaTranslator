import type {
  ChapterStoryMemory,
  PageStoryMemory,
} from "../../shared/workContextTypes";
import type { MangaPage } from "../../shared/libraryTypes";

export function buildPageStoryMemory({
  page,
  pageIndex,
}: {
  page: MangaPage;
  pageIndex: number;
}): PageStoryMemory {
  const sourceLines = page.blocks.map((block) => block.sourceText);
  const translatedLines = page.blocks.map((block) => block.translatedText);
  return {
    pageId: page.id,
    pageName: page.name,
    pageIndex,
    sourceDigest: compactLines(sourceLines, 700),
    translatedDigest: compactLines(translatedLines, 700),
    summary: compactLines(translatedLines, 400),
    characterIds: collectKnownCharacterIds(page),
    updatedAt: new Date().toISOString(),
  };
}

export function upsertPageStoryMemory(
  memory: ChapterStoryMemory,
  pageMemory: PageStoryMemory,
): ChapterStoryMemory {
  const pages = memory.pages.filter(
    (page) => page.pageId !== pageMemory.pageId,
  );
  pages.push(pageMemory);
  pages.sort((left, right) => left.pageIndex - right.pageIndex);
  return {
    ...memory,
    pages,
    updatedAt: new Date().toISOString(),
  };
}

function compactLines(lines: string[], maxChars: number): string {
  const joined = lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" / ");
  return joined.length <= maxChars
    ? joined
    : `${joined.slice(0, Math.max(0, maxChars - 3))}...`;
}

function collectKnownCharacterIds(page: MangaPage): string[] {
  return [
    ...new Set(
      page.blocks
        .map((block) => block.speakerId?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}
