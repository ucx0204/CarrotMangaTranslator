import type { ChapterSnapshot } from "../../../shared/types";
import type { BlockCounts } from "../inpainting/InpaintingContext";

export function countChapterBlocks(chapter: ChapterSnapshot | null, selectedPageId: string | null): BlockCounts {
  if (!chapter) {
    return { total: 0, selectedPage: 0, pendingTotal: 0, pendingPages: 0 };
  }
  return chapter.pages.reduce<BlockCounts>(
    (counts, page) => {
      const targetBlocks = page.blocks.filter((block) => !block.inpaintExcluded).length;
      counts.total += targetBlocks;
      if (page.id === selectedPageId) {
        counts.selectedPage = targetBlocks;
      }
      if (!page.inpaintedImagePath && targetBlocks > 0) {
        counts.pendingPages += 1;
        counts.pendingTotal += targetBlocks;
      }
      return counts;
    },
    { total: 0, selectedPage: 0, pendingTotal: 0, pendingPages: 0 }
  );
}

export function countInpaintedPages(chapter: ChapterSnapshot | null): number {
  return chapter?.pages.filter((page) => Boolean(page.inpaintedImagePath)).length ?? 0;
}
