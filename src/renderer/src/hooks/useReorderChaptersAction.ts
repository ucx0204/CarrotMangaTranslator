import { useCallback } from "react";
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
            "화 순서를 저장하지 못했습니다.",
          );
          pushStatus(`${message} 이전 순서로 되돌렸습니다.`);
        });
    },
    [library.works, pushStatus, setLibrary],
  );
}
