import type {
  ChapterSnapshot,
  LibraryChapter,
} from "../../shared/libraryTypes";
import { normalizeBlockType } from "../../shared/geometry";
import { reorderRecords, resolveChapterStatus } from "./chapterRecords";
import { normalizeResolvedSoundEffectBlocksOnPage } from "../../shared/soundEffectBlocks";

type ChapterFile = LibraryChapter;

export function hydrateChapter(chapter: ChapterFile): ChapterSnapshot {
  const pages = reorderRecords(chapter.pages, chapter.pageOrder).map((page) => {
    return normalizeResolvedSoundEffectBlocksOnPage({
      ...page,
      blocks: page.blocks.map((block) => ({
        ...block,
        type: normalizeBlockType(block.type),
      })),
      dataUrl: "",
    });
  });

  return {
    ...chapter,
    status: resolveChapterStatus(pages),
    pageOrder: pages.map((page) => page.id),
    pages,
  };
}
