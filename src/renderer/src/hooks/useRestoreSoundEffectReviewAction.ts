import { useCallback } from "react";
import type { RestoreSoundEffectReviewRequest } from "../../../shared/analysisTypes";
import { libraryGateway } from "../api/libraryGateway";
import type {
  ApplyChapterAction,
  UseLibraryActionsOptions,
} from "./libraryActionTypes";

export function useRestoreSoundEffectReviewAction({
  currentChapterRef,
  dirty,
  saveNow,
  applyChapter,
}: Pick<UseLibraryActionsOptions, "currentChapterRef" | "dirty" | "saveNow"> & {
  applyChapter: ApplyChapterAction;
}) {
  return useCallback(
    async (request: RestoreSoundEffectReviewRequest) => {
      if (dirty) await saveNow();
      if (currentChapterRef.current?.id !== request.chapterId) {
        throw new Error(
          "검토 중인 화가 변경되었습니다. 모달을 다시 열어 주세요.",
        );
      }
      const chapter = await libraryGateway.restoreSoundEffectReview(request);
      if (currentChapterRef.current?.id === chapter.id) applyChapter(chapter);
      return chapter;
    },
    [applyChapter, currentChapterRef, dirty, saveNow],
  );
}
