import { useCallback } from "react";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import {
  failExportJob,
  resolveInpaintingTarget,
  saveDirtyChanges,
  type InpaintingScope,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useExportInpaintingResultsAction({
  currentChapter,
  dirty,
  jobActive,
  pushStatus,
  saveNow,
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
      if (jobActive || !target) {
        if (scope === "page" && currentChapter) {
          pushStatus("출력할 페이지가 선택되어 있지 않습니다.");
        }
        return;
      }
      try {
        await saveDirtyChanges(dirty, saveNow);
      } catch (error) {
        console.error(error);
        failExportJob(
          setJobState,
          pushStatus,
          formatErrorMessage(
            error,
            "PNG 출력 전에 변경사항을 저장하지 못했습니다.",
          ),
        );
        return;
      }
      setPendingExportJob({ currentChapter, scope, selectedPage, setJobState });
      try {
        const result = await mangaGateway.exportInpaintingResults(
          target.pageId
            ? {
                chapterId: target.chapterId,
                scope: "page",
                pageId: target.pageId,
              }
            : { chapterId: target.chapterId, scope: "chapter" },
        );
        pushStatus(
          result.openError
            ? `PNG 출력은 완료됐지만 폴더를 열지 못했습니다: ${result.outputDir}`
            : `인페인팅 결과를 PNG로 출력했습니다: ${result.pageCount}페이지`,
        );
      } catch (error) {
        console.error(error);
        failExportJob(
          setJobState,
          pushStatus,
          formatErrorMessage(error, "인페인팅 결과를 출력하지 못했습니다."),
        );
      }
    },
    [
      currentChapter,
      dirty,
      jobActive,
      pushStatus,
      saveNow,
      selectedPage,
      setJobState,
    ],
  );
}

function setPendingExportJob({
  currentChapter,
  scope,
  selectedPage,
  setJobState,
}: Pick<
  UseInpaintingActionsOptions,
  "currentChapter" | "selectedPage" | "setJobState"
> & {
  scope: InpaintingScope;
}): void {
  if (!currentChapter) {
    return;
  }
  const targetTotal = scope === "page" ? 1 : currentChapter.pages.length;
  setJobState({
    id: "pending-export",
    kind: "inpainting",
    status: "starting",
    progressText: "PNG 출력 준비 중",
    phase: "finalizing",
    progressCurrent: 0,
    progressTotal: targetTotal,
    pageTotal: targetTotal,
    detail:
      scope === "page"
        ? selectedPage?.name
        : `${currentChapter.pages.length}페이지`,
  });
}
