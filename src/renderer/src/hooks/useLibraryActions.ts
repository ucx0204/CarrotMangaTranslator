import type {
  UseLibraryActionsOptions,
  UseLibraryActionsResult,
} from "./libraryActionTypes";
import { useChapterSelectionActions } from "./useChapterSelectionActions";
import { useLibraryRenameActions } from "./useLibraryRenameActions";
import { useLibraryReorderActions } from "./useLibraryReorderActions";
import { useRemovePageAction } from "./useRemovePageAction";
import { useDismissSoundEffectReviewAction } from "./useDismissSoundEffectReviewAction";

export function useLibraryActions(
  options: UseLibraryActionsOptions,
): UseLibraryActionsResult {
  const chapterActions = useChapterSelectionActions(options);
  const removePage = useRemovePageAction({
    ...options,
    applyChapter: chapterActions.applyChapter,
    refreshLibrary: chapterActions.refreshLibrary,
  });
  const dismissSoundEffectReviewRegion = useDismissSoundEffectReviewAction({
    ...options,
    applyChapter: chapterActions.applyChapter,
  });
  const renameActions = useLibraryRenameActions({
    ...options,
    applyChapter: chapterActions.applyChapter,
    clearCurrentChapter: chapterActions.clearCurrentChapter,
  });
  const reorderActions = useLibraryReorderActions({
    ...options,
    applyChapter: chapterActions.applyChapter,
    refreshLibrary: chapterActions.refreshLibrary,
  });

  return {
    ...chapterActions,
    ...renameActions,
    ...reorderActions,
    dismissSoundEffectReviewRegion,
    removePage,
  };
}
