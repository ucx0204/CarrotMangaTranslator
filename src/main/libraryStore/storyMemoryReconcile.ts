import type { PageStoryMemory } from "../../shared/workContextTypes";

export function reconcilePageStoryMemories(
  memories: PageStoryMemory[],
  pages: Array<{ id: string; name: string }>,
): PageStoryMemory[] {
  const byPageId = new Map(memories.map((memory) => [memory.pageId, memory]));
  return pages.flatMap((page, pageIndex) => {
    const memory = byPageId.get(page.id);
    if (!memory) return [];
    if (memory.pageIndex === pageIndex && memory.pageName === page.name) {
      return [memory];
    }
    return [{ ...memory, pageIndex, pageName: page.name }];
  });
}
