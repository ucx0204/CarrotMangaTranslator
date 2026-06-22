import { useCallback } from "react";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import {
  failInpaintingJob,
  resolveInpaintingTarget,
  type InpaintingScope,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useRevertInpaintingAction({
  askConfirm,
  clearPageImageCache,
  clearRetouchHistory,
  currentChapter,
  jobActive,
  mergeLiveChapter,
  pushStatus,
  selectedPage,
  setJobState,
}: UseInpaintingActionsOptions): (scope: InpaintingScope) => Promise<void> {
  return useCallback(
    async (scope) => {
      const target = resolveInpaintingTarget(
        currentChapter,
        selectedPage,
        scope,
      );
      if (!target || jobActive) {
        return;
      }
      const confirmed = await askConfirm(
        scope === "page"
          ? "이 페이지 원본으로 되돌리기"
          : "전체 페이지 원본으로 되돌리기",
        scope === "page"
          ? "현재 페이지의 인페인팅 결과를 원본 이미지로 되돌립니다."
          : "현재 화의 인페인팅 결과를 원본 이미지로 되돌립니다.",
        "번역 블록과 좌표는 유지하고, 지워진 이미지 결과만 해제합니다.",
      );
      if (!confirmed) {
        return;
      }
      try {
        const result = await mangaGateway.revertInpainting(
          target.pageId
            ? {
                chapterId: target.chapterId,
                scope: "page",
                pageId: target.pageId,
              }
            : { chapterId: target.chapterId, scope: "chapter" },
        );
        clearPageImageCache();
        mergeLiveChapter(result.chapter);
        clearRetouchHistory();
        pushStatus(`인페인팅 되돌리기 완료: ${result.pagesChanged}페이지`);
      } catch (error) {
        console.error(error);
        failInpaintingJob(
          setJobState,
          pushStatus,
          "되돌리기 실패",
          formatErrorMessage(error, "인페인팅 결과를 되돌리지 못했습니다."),
        );
      }
    },
    [
      askConfirm,
      clearPageImageCache,
      clearRetouchHistory,
      currentChapter,
      jobActive,
      mergeLiveChapter,
      pushStatus,
      selectedPage,
      setJobState,
    ],
  );
}
