import { useState } from "react";
import type { RenameTarget } from "../lib/libraryRenameTypes";
import type {
  ApplyChapterAction,
  LibraryRenameActions,
  UseLibraryActionsOptions,
} from "./libraryActionTypes";
import { useDeleteRenameTargetAction } from "./useDeleteRenameTargetAction";
import { useRenameTargetState } from "./useRenameTargetState";
import { useSubmitRenameAction } from "./useSubmitRenameAction";

type LibraryRenameActionsOptions = UseLibraryActionsOptions & {
  applyChapter: ApplyChapterAction;
  clearCurrentChapter: () => void;
};

export function useLibraryRenameActions(
  options: LibraryRenameActionsOptions,
): LibraryRenameActions {
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const targetActions = useRenameTargetState({ ...options, setRenameTarget });

  return {
    ...targetActions,
    deleteRenameTarget: useDeleteRenameTargetAction({
      ...options,
      renameTarget,
      setRenameBusy,
      setRenameTarget,
    }),
    renameBusy,
    renameTarget,
    setRenameTarget,
    submitRename: useSubmitRenameAction({
      ...options,
      renameTarget,
      setRenameBusy,
      setRenameTarget,
    }),
  };
}
