import type { ChapterSnapshot, LibraryChapter } from "../../shared/types";
import { normalizeBlockType } from "../../shared/geometry";
import { reorderRecords } from "./chapterRecords";

type ChapterFile = LibraryChapter;

export function hydrateChapter(chapter: ChapterFile): ChapterSnapshot {
  const pages = reorderRecords(chapter.pages, chapter.pageOrder).map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => ({
      ...block,
      type: normalizeBlockType(block.type)
    })),
    dataUrl: ""
  }));

  return {
    ...chapter,
    pageOrder: pages.map((page) => page.id),
    pages
  };
}
