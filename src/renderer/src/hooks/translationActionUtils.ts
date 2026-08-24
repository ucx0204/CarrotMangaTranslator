import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type {
  AnalysisBlockMode,
  StartAnalysisRequest,
  StartAnalysisResult,
} from "../../../shared/analysisTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { TranslationCompletionWorkflow } from "../../../shared/libraryTypes";
import { analysisGateway as mangaGateway } from "../api/analysisGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import type { LiveChapterMergeOptions } from "../lib/chapterSync";
import { summarizeWarnings } from "../lib/jobProgress";
import {
  toastNotificationPort,
  type NotificationPort,
} from "../lib/notificationPort";
import type { RunAnalysisOutcome } from "./translationFlowHelpers";
import type {
  RunAnalysisMode,
  UseTranslationActionsOptions,
} from "./translationActionTypes";

type SetJobState = Dispatch<SetStateAction<JobState>>;
type TranslateRegionResult = Awaited<
  ReturnType<typeof mangaGateway.translateRegion>
>;

export function failAnalysisJob(
  setJobState: SetJobState,
  pushStatus: (line: string) => void,
  progressText: string,
  message: string,
): void {
  setJobState({
    id: "failed-analysis",
    kind: "gemma-analysis",
    status: "failed",
    progressText,
    phase: "failed",
    detail: message,
  });
  pushStatus(message);
}

export function makeStartAnalysisRequest(
  chapterId: string,
  args: {
    runMode: RunAnalysisMode;
    pageId?: string;
    pageIds?: string[];
    blockMode?: AnalysisBlockMode;
    collectPageContext?: boolean;
    naturalTextLayout?: boolean;
    autoFontMatching?: boolean;
    completionWorkflow?: TranslationCompletionWorkflow;
  },
  t?: TFunction<"renderer">,
): StartAnalysisRequest {
  const {
    runMode,
    pageId,
    pageIds,
    blockMode,
    collectPageContext,
    naturalTextLayout,
    autoFontMatching,
    completionWorkflow,
  } = args;
  const contextOption =
    collectPageContext === undefined ? {} : { collectPageContext };
  const layoutOption =
    naturalTextLayout === undefined ? {} : { naturalTextLayout };
  const fontOption = autoFontMatching === undefined ? {} : { autoFontMatching };
  const completionOption = completionWorkflow ? { completionWorkflow } : {};
  if (runMode === "single-page") {
    if (!pageId) {
      throw new Error(
        t
          ? t("translation.errors.retranslatePageMissing")
          : "다시 번역할 페이지를 찾지 못했습니다.",
      );
    }
    return {
      chapterId,
      runMode,
      pageId,
      blockMode,
      ...contextOption,
      ...layoutOption,
      ...fontOption,
      ...completionOption,
    };
  }
  if (runMode === "page-set") {
    if (!pageIds || pageIds.length === 0) {
      throw new Error(
        t
          ? t("translation.errors.pagesMissing")
          : "번역할 페이지를 찾지 못했습니다.",
      );
    }
    return {
      chapterId,
      runMode,
      pageIds,
      blockMode,
      ...contextOption,
      ...layoutOption,
      ...fontOption,
      ...completionOption,
    };
  }
  return {
    chapterId,
    runMode,
    blockMode,
    ...contextOption,
    ...layoutOption,
    ...fontOption,
    ...completionOption,
  };
}

export function startingJobState(t?: TFunction<"renderer">): JobState {
  return {
    id: "pending",
    kind: "gemma-analysis",
    status: "starting",
    progressText: t ? t("job.phase.booting") : "모델 준비 중",
    phase: "booting",
  };
}

export function resolveStartOutcome(
  result: StartAnalysisResult,
  setJobState: SetJobState,
  pushStatus: (line: string) => void,
  t?: TFunction<"renderer">,
): RunAnalysisOutcome {
  if (result.status === "completed") {
    const warningSummary = summarizeWarnings(result.warnings ?? [], t);
    if (warningSummary) {
      pushStatus(warningSummary);
    }
    return "completed";
  }
  if (result.status === "cancelled") {
    return "cancelled";
  }
  if (result.error) {
    console.error(result.error);
  }
  failAnalysisJob(
    setJobState,
    pushStatus,
    t ? t("translation.errors.jobFailedTitle") : "번역 작업 실패",
    result.error?.trim() ||
      (t ? t("translation.errors.jobFailed") : "번역 작업에 실패했습니다."),
  );
  return "failed";
}

export function reportRefreshLibraryFailure(
  error: unknown,
  pushStatus: (line: string) => void,
  t?: TFunction<"renderer">,
  notificationPort: NotificationPort = toastNotificationPort,
): void {
  const fallback = t
    ? t("library.refreshAfterJobFailed")
    : "보관함 목록을 새로고침하지 못했습니다.";
  // Without a translator the raw message is the only detail available, but the
  // failure still has to pass the presentation boundary so it gets logged.
  const line =
    !t && error instanceof Error && error.message.trim()
      ? error.message
      : fallback;
  pushStatus(formatErrorMessage(error, line));
  notificationPort.warn(
    t
      ? t("translation.refreshWarning")
      : "번역은 완료됐지만 보관함 목록 새로고침에 실패했습니다.",
  );
}

export async function refreshLibraryWithWarning(
  refreshLibrary: () => Promise<void>,
  pushStatus: (line: string) => void,
  t: TFunction<"renderer"> | undefined,
  notificationPort: NotificationPort,
): Promise<void> {
  try {
    await refreshLibrary();
  } catch (error) {
    reportRefreshLibraryFailure(error, pushStatus, t, notificationPort);
  }
}

export function regionTranslationStartingState(
  t?: TFunction<"renderer">,
): JobState {
  return {
    id: "pending",
    kind: "gemma-analysis",
    status: "starting",
    progressText: t
      ? t("regionTranslation.preparing")
      : "선택 영역 번역 준비 중",
    phase: "booting",
    progressCurrent: 0,
    progressTotal: 1,
    pageIndex: 1,
    pageTotal: 1,
  };
}

/**
 * 영역 번역 완료 시 라이브 병합 옵션: 페이지가 로컬에서 dirty 상태여도
 * 새로 만든 영역 블록이 유실되지 않도록 append 대상을 알려 준다.
 */
function regionLiveMergeOptions(
  result: TranslateRegionResult,
): LiveChapterMergeOptions | undefined {
  if (
    result.status !== "completed" ||
    !result.pageId ||
    !result.blockIds ||
    result.blockIds.length === 0
  ) {
    return undefined;
  }
  return {
    appendLiveBlocks: {
      pageId: result.pageId,
      blockIds: result.blockIds,
    },
  };
}

export function mergeTranslatedRegionResult(
  result: TranslateRegionResult,
  {
    currentChapterRef,
    mergeLiveChapter,
    selectedPageId,
    syncSavedPageVersion,
  }: Pick<
    UseTranslationActionsOptions,
    "currentChapterRef" | "mergeLiveChapter" | "syncSavedPageVersion"
  > & { selectedPageId: string },
): void {
  if (!result.chapter) {
    return;
  }
  mergeLiveChapter(result.chapter, regionLiveMergeOptions(result));
  if (
    result.status === "completed" &&
    currentChapterRef.current?.id === result.chapter.id
  ) {
    syncSavedPageVersion(result.chapter, result.pageId ?? selectedPageId);
  }
}

export function handleTranslateRegionResult(
  result: TranslateRegionResult,
  {
    pushStatus,
    setJobState,
    setSelectedBlockId,
  }: {
    pushStatus: UseTranslationActionsOptions["pushStatus"];
    setJobState: SetJobState;
    setSelectedBlockId: UseTranslationActionsOptions["setSelectedBlockId"];
  },
  t?: TFunction<"renderer">,
): void {
  if (result.status === "completed") {
    reportCompletedRegionTranslation(result, pushStatus, setSelectedBlockId, t);
    return;
  }
  if (result.status === "cancelled") {
    return;
  }
  if (result.status === "failed") {
    if (result.error) {
      console.error(result.error);
    }
    failAnalysisJob(
      setJobState,
      pushStatus,
      t ? t("regionTranslation.failedTitle") : "선택 영역 번역 실패",
      result.error?.trim() ||
        (t ? t("regionTranslation.failed") : "선택 영역 번역에 실패했습니다."),
    );
  }
}

function reportCompletedRegionTranslation(
  result: TranslateRegionResult,
  pushStatus: UseTranslationActionsOptions["pushStatus"],
  setSelectedBlockId: UseTranslationActionsOptions["setSelectedBlockId"],
  t?: TFunction<"renderer">,
): void {
  if (result.blockIds?.[0]) {
    setSelectedBlockId(result.blockIds[0]);
  }
  const warningSummary = summarizeWarnings(result.warnings ?? [], t);
  pushStatus(
    warningSummary ||
      (t
        ? t("regionTranslation.success", {
            count: result.blockIds?.length ?? 0,
          })
        : `선택 영역에서 ${result.blockIds?.length ?? 0}개 블록을 만들었습니다.`),
  );
}
