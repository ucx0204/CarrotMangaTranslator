import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { formatErrorMessage } from "../lib/errorPresentation";
import type { RenameTarget } from "../lib/libraryRenameTypes";
import { libraryGateway } from "../api/libraryGateway";
import type { UseLibraryActionsOptions } from "./libraryActionTypes";

type DeleteRenameTargetActionOptions = Pick<
  UseLibraryActionsOptions,
  | "askConfirm"
  | "currentChapter"
  | "dirty"
  | "pushStatus"
  | "saveNow"
  | "setLibrary"
> & {
  clearCurrentChapter: () => void;
  renameTarget: RenameTarget | null;
  setRenameBusy: (busy: boolean) => void;
  setRenameTarget: (target: RenameTarget | null) => void;
};

function buildDeleteDetail(
  renameTarget: RenameTarget,
  t: TFunction<"renderer">,
): string {
  return renameTarget.kind === "work"
    ? t("library.delete.workDetail", { title: renameTarget.title })
    : t("library.delete.chapterDetail", { title: renameTarget.title });
}

function deleteSuccessStatus(
  renameTarget: RenameTarget,
  t: TFunction<"renderer">,
): string {
  return renameTarget.kind === "work"
    ? t("library.delete.workSuccess", { title: renameTarget.title })
    : t("library.delete.chapterSuccess", { title: renameTarget.title });
}

function deleteFailureStatus(
  renameTarget: RenameTarget,
  t: TFunction<"renderer">,
): string {
  return renameTarget.kind === "work"
    ? t("library.delete.workFailed")
    : t("library.delete.chapterFailed");
}

function resolveDeleteContext(
  currentChapterId: string | null,
  currentWorkId: string | null,
  renameTarget: RenameTarget,
): {
  isCurrentChapter: boolean;
  isCurrentWork: boolean;
} {
  return {
    isCurrentChapter: currentChapterId === renameTarget.id,
    isCurrentWork:
      renameTarget.kind === "work" && currentWorkId === renameTarget.id,
  };
}

async function deleteLibraryRenameTarget(
  renameTarget: RenameTarget,
  setLibrary: DeleteRenameTargetActionOptions["setLibrary"],
): Promise<void> {
  const nextLibrary =
    renameTarget.kind === "work"
      ? await libraryGateway.deleteWork(renameTarget.id)
      : await libraryGateway.deleteChapter(renameTarget.id);
  setLibrary(nextLibrary);
}

function clearCurrentSelectionAfterDelete(
  renameTarget: RenameTarget,
  context: ReturnType<typeof resolveDeleteContext>,
  clearCurrentChapter: () => void,
): void {
  if (
    (renameTarget.kind === "work" && context.isCurrentWork) ||
    (renameTarget.kind === "chapter" && context.isCurrentChapter)
  ) {
    clearCurrentChapter();
  }
}

export function useDeleteRenameTargetAction({
  askConfirm,
  clearCurrentChapter,
  currentChapter,
  dirty,
  pushStatus,
  renameTarget,
  saveNow,
  setLibrary,
  setRenameBusy,
  setRenameTarget,
}: DeleteRenameTargetActionOptions): () => Promise<void> {
  const { t } = useTranslation("renderer");
  const currentChapterId = currentChapter?.id ?? null;
  const currentWorkId = currentChapter?.workId ?? null;

  return useCallback(async () => {
    if (!renameTarget) {
      return;
    }

    const context = resolveDeleteContext(
      currentChapterId,
      currentWorkId,
      renameTarget,
    );
    const confirmed = await askConfirm(
      renameTarget.kind === "work"
        ? t("library.delete.workTitle")
        : t("library.delete.chapterTitle"),
      t("library.delete.confirm"),
      buildDeleteDetail(renameTarget, t),
    );
    if (!confirmed) {
      return;
    }

    setRenameBusy(true);
    try {
      if ((context.isCurrentChapter || context.isCurrentWork) && dirty) {
        await saveNow();
      }
      await deleteLibraryRenameTarget(renameTarget, setLibrary);
      clearCurrentSelectionAfterDelete(
        renameTarget,
        context,
        clearCurrentChapter,
      );
      pushStatus(deleteSuccessStatus(renameTarget, t));
      setRenameTarget(null);
    } catch (error) {
      console.error(error);
      pushStatus(
        formatErrorMessage(error, deleteFailureStatus(renameTarget, t)),
      );
    } finally {
      setRenameBusy(false);
    }
  }, [
    askConfirm,
    clearCurrentChapter,
    currentChapterId,
    currentWorkId,
    dirty,
    pushStatus,
    renameTarget,
    saveNow,
    setLibrary,
    setRenameBusy,
    setRenameTarget,
    t,
  ]);
}
