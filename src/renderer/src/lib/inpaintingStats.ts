import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { BlockCounts } from "../inpainting/inpaintingTypes";

type PageInpaintingStats = {
  inpainted: boolean;
  targetBlockCount: number;
};

const pageStatsCache = new WeakMap<MangaPage, PageInpaintingStats>();

export function countChapterBlocks(
  chapter: ChapterSnapshot | null,
  selectedPageId: string | null,
): BlockCounts {
  if (!chapter) {
    return { total: 0, selectedPage: 0, pendingTotal: 0, pendingPages: 0 };
  }
  return chapter.pages.reduce<BlockCounts>(
    (counts, page) => {
      const stats = resolvePageInpaintingStats(page);
      counts.total += stats.targetBlockCount;
      if (page.id === selectedPageId) {
        counts.selectedPage = stats.targetBlockCount;
      }
      if (!stats.inpainted && stats.targetBlockCount > 0) {
        counts.pendingPages += 1;
        counts.pendingTotal += stats.targetBlockCount;
      }
      return counts;
    },
    { total: 0, selectedPage: 0, pendingTotal: 0, pendingPages: 0 },
  );
}

export function countInpaintedPages(chapter: ChapterSnapshot | null): number {
  return (
    chapter?.pages.reduce(
      (count, page) =>
        count + (resolvePageInpaintingStats(page).inpainted ? 1 : 0),
      0,
    ) ?? 0
  );
}

function resolvePageInpaintingStats(page: MangaPage): PageInpaintingStats {
  const cached = pageStatsCache.get(page);
  if (cached) return cached;
  const stats = {
    inpainted: Boolean(page.inpaintedImagePath),
    targetBlockCount: page.blocks.reduce(
      (count, block) => count + (block.inpaintExcluded ? 0 : 1),
      0,
    ),
  };
  pageStatsCache.set(page, stats);
  return stats;
}
