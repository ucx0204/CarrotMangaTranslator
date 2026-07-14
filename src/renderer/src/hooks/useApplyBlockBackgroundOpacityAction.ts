import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";

export type BlockBackgroundApplyScope = "page" | "chapter";

type Options = {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  pushStatus: (line: string) => void;
  selectedBlock: TranslationBlock | null;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  updateCurrentChapter: UpdateCurrentChapter;
};

export function useApplyBlockBackgroundOpacityAction({
  currentChapter,
  jobActive,
  pushStatus,
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: Options): (scope: BlockBackgroundApplyScope) => void {
  const { t } = useTranslation("renderer");
  return useCallback(
    (scope: BlockBackgroundApplyScope) => {
      if (!currentChapter || !selectedBlock || selectedPageEditLocked) {
        return;
      }
      if (scope === "chapter" && jobActive) {
        pushStatus(t("blockEditing.backgroundOpacityChapterApplyWhileRunning"));
        return;
      }
      const targetPageIds = resolveTargetPageIds(
        scope,
        currentChapter,
        selectedPage,
      );
      if (targetPageIds.length === 0) {
        return;
      }
      let applied = false;
      const dirtyPageIds: string[] = [];
      updateCurrentChapter(
        targetPageIds[0],
        (current) => {
          const result = applyBackgroundOpacityWithDirtyPages(
            current,
            new Set(targetPageIds),
            selectedBlock.opacity,
          );
          applied = result.chapter !== current;
          dirtyPageIds.push(...result.dirtyPageIds);
          return result.chapter;
        },
        {
          dirtyPageIds,
          label: t("workspaceHistory.blockBackgroundOpacity"),
        },
      );
      if (!applied) return;
      pushStatus(
        t(
          scope === "page"
            ? "blockEditing.backgroundOpacityAppliedPage"
            : "blockEditing.backgroundOpacityAppliedChapter",
        ),
      );
    },
    [
      currentChapter,
      jobActive,
      pushStatus,
      selectedBlock,
      selectedPage,
      selectedPageEditLocked,
      t,
      updateCurrentChapter,
    ],
  );
}

function resolveTargetPageIds(
  scope: BlockBackgroundApplyScope,
  chapter: ChapterSnapshot,
  selectedPage: MangaPage | null,
): string[] {
  if (scope === "chapter") {
    return chapter.pages.map((page) => page.id);
  }
  return selectedPage ? [selectedPage.id] : [];
}

export function applyBackgroundOpacity(
  chapter: ChapterSnapshot,
  targetPageIds: ReadonlySet<string>,
  opacity: number,
): ChapterSnapshot {
  return applyBackgroundOpacityWithDirtyPages(chapter, targetPageIds, opacity)
    .chapter;
}

function applyBackgroundOpacityWithDirtyPages(
  chapter: ChapterSnapshot,
  targetPageIds: ReadonlySet<string>,
  opacity: number,
): { chapter: ChapterSnapshot; dirtyPageIds: string[] } {
  const normalizedOpacity = Math.min(1, Math.max(0, opacity));
  const stamp = new Date().toISOString();
  const dirtyPageIds: string[] = [];
  const pages = chapter.pages.map((page) => {
    if (!targetPageIds.has(page.id)) {
      return page;
    }
    const blocks = page.blocks.map((block) =>
      block.opacity === normalizedOpacity
        ? block
        : { ...block, opacity: normalizedOpacity },
    );
    if (blocks.every((block, index) => block === page.blocks[index])) {
      return page;
    }
    dirtyPageIds.push(page.id);
    return { ...page, blocks, updatedAt: stamp };
  });
  return dirtyPageIds.length > 0
    ? { chapter: { ...chapter, pages }, dirtyPageIds }
    : { chapter, dirtyPageIds };
}
