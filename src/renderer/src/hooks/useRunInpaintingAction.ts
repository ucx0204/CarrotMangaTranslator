import { useCallback } from "react";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import {
  failInpaintingJob,
  refreshLibraryWithStatus,
  resolveInpaintingTarget,
  saveDirtyChanges,
  type InpaintingScope,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useRunInpaintingAction(
  options: UseInpaintingActionsOptions,
): (scope: InpaintingScope) => Promise<void> {
  return useCallback(
    async (scope) => {
      await runPatternInpainting(options, scope);
    },
    [options],
  );
}

async function runPatternInpainting(
  options: UseInpaintingActionsOptions,
  scope: InpaintingScope,
): Promise<void> {
  const target = resolveInpaintingTarget(
    options.currentChapter,
    options.selectedPage,
    scope,
  );
  if (!target || options.jobActive) {
    return;
  }
  const ready = await preparePatternInpainting(options, scope);
  if (!ready) {
    return;
  }
  try {
    const result = await mangaGateway.startInpainting(
      target.pageId
        ? {
            chapterId: target.chapterId,
            mode: "page-pattern",
            pageId: target.pageId,
          }
        : { chapterId: target.chapterId, mode: "chapter-pattern-pending" },
    );
    if (result.chapter) {
      options.clearRetouchHistory();
      options.clearPageImageCache();
      options.mergeLiveChapter(result.chapter);
    }
    await refreshLibraryWithStatus(options.refreshLibrary, options.pushStatus);
    reportPatternInpaintingResult(result, options.pushStatus);
  } catch (error) {
    console.error(error);
    failInpaintingJob(
      options.setJobState,
      options.pushStatus,
      "작업 실패",
      formatErrorMessage(error, "원문 지우기를 시작하지 못했습니다."),
    );
  }
}

async function preparePatternInpainting(
  options: UseInpaintingActionsOptions,
  scope: InpaintingScope,
): Promise<boolean> {
  try {
    await saveDirtyChanges(options.dirty, options.saveNow);
  } catch (error) {
    console.error(error);
    failInpaintingJob(
      options.setJobState,
      options.pushStatus,
      "저장 실패",
      formatErrorMessage(
        error,
        "원문 지우기 전에 변경사항을 저장하지 못했습니다.",
      ),
    );
    return false;
  }
  const confirmed = await confirmPatternInpainting(options.askConfirm, scope);
  if (!confirmed) {
    return false;
  }
  options.setJobState({
    id: "pending-inpainting",
    kind: "inpainting",
    status: "starting",
    progressText: "원문 지우기 준비 중",
    phase: "inpainting_preparing",
  });
  return true;
}

function confirmPatternInpainting(
  askConfirm: UseInpaintingActionsOptions["askConfirm"],
  scope: InpaintingScope,
): Promise<boolean> {
  const scopeLabel =
    scope === "page" ? "현재 페이지" : "아직 지우지 않은 페이지";
  return askConfirm(
    "원문 지우기",
    `${scopeLabel}의 번역 블록 위치에 있는 원문을 지웁니다.`,
    "말풍선, 톤, 배경 그림, 효과음 위 글자까지 모두 Flux 인페인팅으로 지웁니다. 원본 이미지는 유지하고 결과 이미지는 별도로 저장합니다.",
  );
}

function reportPatternInpaintingResult(
  result: Awaited<ReturnType<typeof mangaGateway.startInpainting>>,
  pushStatus: (line: string) => void,
): void {
  if (result.status === "completed") {
    pushStatus(
      `원문 지우기 완료: ${result.pagesChanged ?? 0}페이지, ${result.blocksErased ?? 0}블록`,
    );
  } else if (result.status === "failed" && result.error) {
    pushStatus(result.error);
  }
}
