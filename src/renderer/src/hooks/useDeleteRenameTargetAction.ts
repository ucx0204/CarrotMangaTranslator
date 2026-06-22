import { useCallback } from "react";
import type { RenameTarget } from "../components/AppModals";
import { formatErrorMessage } from "../lib/appHelpers";
import { libraryGateway } from "./libraryGateway";
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

function buildDeleteDetail(renameTarget: RenameTarget): string {
  return renameTarget.kind === "work"
    ? `"${renameTarget.title}" 작품과 포함된 모든 화, 페이지, 번역 결과가 보관함에서 삭제됩니다.`
    : `"${renameTarget.title}" 화와 포함된 모든 페이지, 번역 결과가 보관함에서 삭제됩니다.`;
}

function deleteSuccessStatus(renameTarget: RenameTarget): string {
  return renameTarget.kind === "work"
    ? `${renameTarget.title} 작품을 삭제했습니다.`
    : `${renameTarget.title} 화를 삭제했습니다.`;
}

function deleteFailureStatus(renameTarget: RenameTarget): string {
  return renameTarget.kind === "work"
    ? "작품을 삭제하지 못했습니다."
    : "화를 삭제하지 못했습니다.";
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
      renameTarget.kind === "work" ? "작품 삭제" : "화 삭제",
      "정말 삭제하시겠습니까?",
      buildDeleteDetail(renameTarget),
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
      pushStatus(deleteSuccessStatus(renameTarget));
      setRenameTarget(null);
    } catch (error) {
      console.error(error);
      pushStatus(formatErrorMessage(error, deleteFailureStatus(renameTarget)));
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
  ]);
}
