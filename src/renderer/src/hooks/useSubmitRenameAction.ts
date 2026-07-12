import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { formatErrorMessage } from "../lib/appHelpers";
import type { RenameTarget } from "../lib/libraryRenameTypes";
import { libraryGateway } from "./libraryGateway";
import type {
  ApplyChapterAction,
  UseLibraryActionsOptions,
} from "./libraryActionTypes";

type SubmitRenameActionOptions = Pick<
  UseLibraryActionsOptions,
  "currentChapter" | "dirty" | "pushStatus" | "saveNow" | "setLibrary"
> & {
  applyChapter: ApplyChapterAction;
  renameTarget: RenameTarget | null;
  setRenameBusy: (busy: boolean) => void;
  setRenameTarget: (target: RenameTarget | null) => void;
};

async function saveCurrentChapterBeforeRename(
  dirty: boolean,
  saveNow: () => Promise<void>,
): Promise<void> {
  if (dirty) {
    await saveNow();
  }
}

export function useSubmitRenameAction({
  applyChapter,
  currentChapter,
  dirty,
  pushStatus,
  renameTarget,
  saveNow,
  setLibrary,
  setRenameBusy,
  setRenameTarget,
}: SubmitRenameActionOptions): (title: string) => Promise<void> {
  const { t } = useTranslation("renderer");
  const currentChapterId = currentChapter?.id ?? null;

  return useCallback(
    async (title) => {
      if (!renameTarget) {
        return;
      }

      setRenameBusy(true);
      try {
        if (renameTarget.kind === "work") {
          setLibrary(await libraryGateway.renameWork(renameTarget.id, title));
        } else {
          if (currentChapterId === renameTarget.id) {
            await saveCurrentChapterBeforeRename(dirty, saveNow);
          }
          setLibrary(
            await libraryGateway.renameChapter(renameTarget.id, title),
          );
          if (currentChapterId === renameTarget.id) {
            applyChapter(await libraryGateway.openChapter(renameTarget.id));
          }
        }
        setRenameTarget(null);
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, t("library.renameFailed")));
      } finally {
        setRenameBusy(false);
      }
    },
    [
      applyChapter,
      currentChapterId,
      dirty,
      pushStatus,
      renameTarget,
      saveNow,
      setLibrary,
      setRenameBusy,
      setRenameTarget,
      t,
    ],
  );
}
