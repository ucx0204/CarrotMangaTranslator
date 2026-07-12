import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { formatErrorMessage, reorderByTarget } from "../lib/appHelpers";
import { libraryGateway } from "./libraryGateway";
import type { UseLibraryActionsOptions } from "./libraryActionTypes";
import {
  reorderChapterSummaries,
  rollbackChapterSummaries,
} from "./libraryOrderHelpers";

type ReorderChaptersActionOptions = Pick<
  UseLibraryActionsOptions,
  "library" | "pushStatus" | "setLibrary"
>;

export function useReorderChaptersAction({
  library,
  pushStatus,
  setLibrary,
}: ReorderChaptersActionOptions): (
  workId: string,
  sourceChapterId: string,
  targetChapterId: string,
) => void {
  const { t } = useTranslation("renderer");
  return useCallback(
    (workId, sourceChapterId, targetChapterId) => {
      const work = library.works.find((candidate) => candidate.id === workId);
      if (!work) {
        return;
      }
      const previousOrder = work.chapterOrder;
      const nextOrder = reorderByTarget(
        previousOrder,
        sourceChapterId,
        targetChapterId,
      );
      setLibrary((current) =>
        reorderChapterSummaries(current, workId, nextOrder),
      );
      void libraryGateway
        .reorderChapters(workId, nextOrder)
        .then(setLibrary)
        .catch((error) => {
          console.error(error);
          setLibrary((current) =>
            rollbackChapterSummaries(current, workId, nextOrder, previousOrder),
          );
          const message = formatErrorMessage(
            error,
            t("library.order.chapterSaveFailed"),
          );
          pushStatus(t("library.order.rolledBackAfterError", { message }));
        });
    },
    [library.works, pushStatus, setLibrary, t],
  );
}
