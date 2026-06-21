import type {
  ChapterStoryMemory,
  PromptWorkContext,
  WorkStyleGuide,
} from "../../shared/types";

export function buildPromptWorkContextForPage({
  baseStyleGuide,
  storyMemory,
  pageIndex,
  recentPageCount = 6,
}: {
  baseStyleGuide: WorkStyleGuide;
  storyMemory: ChapterStoryMemory;
  pageId: string;
  pageIndex: number;
  recentPageCount?: number;
}): PromptWorkContext {
  const recentPages = storyMemory.pages
    .filter((page) => page.pageIndex < pageIndex)
    .sort((left, right) => right.pageIndex - left.pageIndex)
    .slice(0, recentPageCount)
    .reverse();
  return {
    styleGuide: baseStyleGuide,
    storyMemory: {
      ...storyMemory,
      pages: recentPages,
    },
    recentPageCount,
  };
}
