import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type {
  AnalysisBlockMode,
  StartAnalysisRequest,
  StartAnalysisResult,
} from "../../../shared/analysisTypes";
import type { JobState } from "../../../shared/jobTypes";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import type { LiveChapterMergeOptions } from "../lib/chapterSync";
import { summarizeWarnings } from "../lib/jobProgress";
import { toast } from "../lib/toastStore";
import {
  toSecondPassSelection,
  type ChapterRunSelection,
} from "../lib/translationSelection";
import {
  runSelectionsSequentially,
  type ExecuteAnalysisJob,
  type RunAnalysisOutcome,
} from "./translationFlowHelpers";
import type {
  RunAnalysisMode,
  TranslationFlowOptions,
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
  },
  t?: TFunction<"renderer">,
): StartAnalysisRequest {
  const { runMode, pageId, pageIds, blockMode } = args;
  if (runMode === "single-page") {
    if (!pageId) {
      throw new Error(
        t
          ? t("translation.errors.retranslatePageMissing")
          : "다시 번역할 페이지를 찾지 못했습니다.",
      );
    }
    return { chapterId, runMode, pageId, blockMode };
  }
  if (runMode === "page-set") {
    if (!pageIds || pageIds.length === 0) {
      throw new Error(
        t
          ? t("translation.errors.pagesMissing")
          : "번역할 페이지를 찾지 못했습니다.",
      );
    }
    return { chapterId, runMode, pageIds, blockMode };
  }
  return { chapterId, runMode, blockMode };
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
    t ? t("translation.errors.jobFailed") : "번역 작업에 실패했습니다.",
  );
  return "failed";
}

export function reportRefreshLibraryFailure(
  error: unknown,
  pushStatus: (line: string) => void,
  t?: TFunction<"renderer">,
): void {
  console.error(error);
  const fallback = t
    ? t("library.refreshAfterJobFailed")
    : "보관함 목록을 새로고침하지 못했습니다.";
  pushStatus(
    t
      ? formatErrorMessage(error, fallback)
      : error instanceof Error && error.message.trim()
        ? error.message
        : fallback,
  );
  toast.warn(
    t
      ? t("translation.refreshWarning")
      : "번역은 완료됐지만 보관함 목록 새로고침에 실패했습니다.",
  );
}

export async function refreshLibraryWithWarning(
  refreshLibrary: () => Promise<void>,
  pushStatus: (line: string) => void,
  t?: TFunction<"renderer">,
): Promise<void> {
  try {
    await refreshLibrary();
  } catch (error) {
    reportRefreshLibraryFailure(error, pushStatus, t);
  }
}

export async function runWorkContextAnalysis({
  analysisScope,
  chapterId,
  pushStatus,
  refreshLibrary,
  setJobState,
  t,
}: {
  analysisScope: TranslationFlowOptions["analysisScope"];
  chapterId: string;
  pushStatus: UseTranslationActionsOptions["pushStatus"];
  refreshLibrary: UseTranslationActionsOptions["refreshLibrary"];
  setJobState: SetJobState;
  t?: TFunction<"renderer">;
}): Promise<boolean> {
  setJobState({
    id: "flow-analysis",
    kind: "gemma-analysis",
    status: "running",
    progressText: t
      ? t("translation.flow.contextAnalysis")
      : "AI 용어/기억 분석 중",
    phase: "model_requesting",
    progressMode: "indeterminate",
  });
  try {
    await mangaGateway.analyzeWorkContext({ chapterId, scope: analysisScope });
    await refreshLibraryWithWarning(refreshLibrary, pushStatus, t);
    return true;
  } catch (error) {
    console.error(error);
    setJobState({
      id: "flow-analysis-skipped",
      kind: "gemma-analysis",
      status: "completed",
      progressText: t
        ? t("translation.flow.contextSkipped")
        : "1차 번역 완료 (AI 분석 건너뜀)",
      phase: "done",
    });
    toast.error(
      t
        ? t("translation.flow.contextFailed")
        : "AI 용어/기억 분석에 실패해 1차 번역 결과만 유지합니다.",
    );
    return false;
  }
}

export async function runSecondTranslationPass(
  executeAnalysisJob: ExecuteAnalysisJob,
  selection: ChapterRunSelection[],
  pushStatus: UseTranslationActionsOptions["pushStatus"],
  blockMode?: AnalysisBlockMode,
  t?: TFunction<"renderer">,
): Promise<void> {
  const pass2 = await runSelectionsSequentially(
    executeAnalysisJob,
    selection.map(toSecondPassSelection),
    pushStatus,
    t ? t("translation.flow.secondPass") : "2차",
    blockMode,
    t,
  );
  if (pass2 === "completed") {
    toast.success(
      t
        ? t("translation.flow.secondPassCompleted")
        : "2차 번역까지 완료했습니다.",
    );
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
export function regionLiveMergeOptions(
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
  if (result.status === "failed") {
    if (result.error) {
      console.error(result.error);
    }
    failAnalysisJob(
      setJobState,
      pushStatus,
      t ? t("regionTranslation.failedTitle") : "선택 영역 번역 실패",
      t ? t("regionTranslation.failed") : "선택 영역 번역에 실패했습니다.",
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
