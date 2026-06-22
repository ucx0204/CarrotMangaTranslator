import type {
  ApplyChapterAction,
  LibraryReorderActions,
  UseLibraryActionsOptions,
} from "./libraryActionTypes";
import { useReorderChaptersAction } from "./useReorderChaptersAction";
import { useReorderPagesAction } from "./useReorderPagesAction";

type LibraryReorderActionsOptions = UseLibraryActionsOptions & {
  applyChapter: ApplyChapterAction;
  refreshLibrary: () => Promise<void>;
};

export function useLibraryReorderActions(
  options: LibraryReorderActionsOptions,
): LibraryReorderActions {
  return {
    reorderChapterInLibrary: useReorderChaptersAction(options),
    reorderPageInChapter: useReorderPagesAction(options),
  };
}
