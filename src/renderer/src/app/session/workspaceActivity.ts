import {
  activityResourcesConflict,
  pageContentResource,
} from "../../../../shared/appActivityTypes";
import type { AppSessionViewModel } from "./appSessionViewModel";

export function isWorkspaceJobActive(
  derivedState: AppSessionViewModel["derivedState"],
  workspaceHistory: AppSessionViewModel["workspaceHistory"],
  _libraryDrop: AppSessionViewModel["libraryDrop"],
): boolean {
  return derivedState.selectedPageEditLocked || workspaceHistory.busy;
}

export function isChapterMutationBlocked(model: AppSessionViewModel): boolean {
  if (model.workspaceHistory.busy) return true;
  const chapter = model.core.currentChapter;
  const state = model.derivedState.activities;
  if (!state || !chapter)
    return Boolean(model.derivedState.selectedPageEditLocked);
  const resources = chapter.pages.map((page) =>
    pageContentResource(chapter.id, page.id),
  );
  return (
    state.activities.some((activity) =>
      activityResourcesConflict(resources, activity.resources),
    ) ||
    state.pages.some(
      (page) =>
        page.chapterId === chapter.id && page.phase === "finishing-edits",
    )
  );
}
