import type {
  LibraryChapterSelectionActions,
  UseLibraryActionsOptions,
} from "./libraryActionTypes";
import { useApplyChapterAction } from "./useApplyChapterAction";
import { useClearCurrentChapterAction } from "./useClearCurrentChapterAction";
import { useOpenChapterAction } from "./useOpenChapterAction";
import { useRefreshLibraryAction } from "./useRefreshLibraryAction";

export function useChapterSelectionActions(
  options: UseLibraryActionsOptions,
): LibraryChapterSelectionActions {
  return {
    applyChapter: useApplyChapterAction(options),
    clearCurrentChapter: useClearCurrentChapterAction(options),
    openChapter: useOpenChapterAction(options),
    refreshLibrary: useRefreshLibraryAction(options),
  };
}
