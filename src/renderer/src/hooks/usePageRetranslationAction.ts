import { useCallback } from "react";
import type { ChapterSnapshot, RunMode } from "../../../shared/types";

type UsePageRetranslationActionOptions = {
  askConfirm: (title: string, message: string, detail?: string) => Promise<boolean>;
  currentChapter: ChapterSnapshot | null;
  runAnalysis: (runMode: RunMode, pageId?: string) => Promise<void>;
};

export function usePageRetranslationAction({
  askConfirm,
  currentChapter,
  runAnalysis
}: UsePageRetranslationActionOptions): (pageId: string) => Promise<void> {
  return useCallback(
    async (pageId) => {
      const page = currentChapter?.pages.find((candidate) => candidate.id === pageId);
      if (!page || !currentChapter) {
        return;
      }
      const confirmed = await askConfirm(
        "페이지 재번역",
        "정말 재번역 하시겠습니까?",
        "기존 번역 결과와 수정 내용이 이 페이지에서 덮어써집니다."
      );
      if (!confirmed) {
        return;
      }
      await runAnalysis("single-page", pageId);
    },
    [askConfirm, currentChapter, runAnalysis]
  );
}
