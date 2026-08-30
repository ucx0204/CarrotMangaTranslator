import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { UseImportShareActionsOptions } from "./importShareActionTypes";

export async function finishImportedChapterNavigation({
  applyChapter,
  chapter,
  getNavigationKey,
  navigationKey,
  openTranslateOptions,
  openWorkTranslation,
  pushStatus,
  resetWorkspaceHistory,
  saveNow,
  status,
}: {
  applyChapter: UseImportShareActionsOptions["applyChapter"];
  chapter: ChapterSnapshot | undefined;
  getNavigationKey: () => string;
  navigationKey: string;
  openTranslateOptions: UseImportShareActionsOptions["openTranslateOptions"];
  openWorkTranslation: boolean;
  pushStatus: UseImportShareActionsOptions["pushStatus"];
  resetWorkspaceHistory: UseImportShareActionsOptions["resetWorkspaceHistory"];
  saveNow: UseImportShareActionsOptions["saveNow"];
  status: string;
}): Promise<void> {
  if (!chapter) {
    pushStatus(status);
    return;
  }
  try {
    await saveNow();
  } catch (_error) {
    pushStatus(status);
    return;
  }
  if (getNavigationKey() !== navigationKey) {
    pushStatus(status);
    return;
  }
  resetWorkspaceHistory();
  applyChapter(chapter, status);
  if (openWorkTranslation) openTranslateOptions("work-all");
}
