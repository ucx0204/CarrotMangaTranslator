import type { Dispatch, SetStateAction } from "react";
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
): StartAnalysisRequest {
  const { runMode, pageId, pageIds, blockMode } = args;
  if (runMode === "single-page") {
    if (!pageId) {
      throw new Error("다시 번역할 페이지를 찾지 못했습니다.");
    }
    return { chapterId, runMode, pageId, blockMode };
  }
  if (runMode === "page-set") {
    if (!pageIds || pageIds.length === 0) {
      throw new Error("번역할 페이지를 찾지 못했습니다.");
    }
    return { chapterId, runMode, pageIds, blockMode };
  }
  return { chapterId, runMode, blockMode };
}

export function startingJobState(): JobState {
  return {
    id: "pending",
    kind: "gemma-analysis",
    status: "starting",
    progressText: "모델 준비 중",
    phase: "booting",
  };
}

export function resolveStartOutcome(
  result: StartAnalysisResult,
  setJobState: SetJobState,
  pushStatus: (line: string) => void,
): RunAnalysisOutcome {
  if (result.status === "completed") {
    const warningSummary = summarizeWarnings(result.warnings ?? []);
    if (warningSummary) {
      pushStatus(warningSummary);
    }
    return "completed";
  }
  if (result.status === "cancelled") {
    return "cancelled";
  }
  failAnalysisJob(
    setJobState,
    pushStatus,
    "번역 작업 실패",
    result.error ?? "번역 작업에 실패했습니다.",
  );
  return "failed";
}

export function reportRefreshLibraryFailure(
  error: unknown,
  pushStatus: (line: string) => void,
): void {
  console.error(error);
  pushStatus(
    formatErrorMessage(error, "보관함 목록을 새로고침하지 못했습니다."),
  );
  toast.warn("번역은 완료됐지만 보관함 목록 새로고침에 실패했습니다.");
}

export async function refreshLibraryWithWarning(
  refreshLibrary: () => Promise<void>,
  pushStatus: (line: string) => void,
): Promise<void> {
  try {
    await refreshLibrary();
  } catch (error) {
    reportRefreshLibraryFailure(error, pushStatus);
  }
}

export async function runWorkContextAnalysis({
  analysisScope,
  chapterId,
  pushStatus,
  refreshLibrary,
  setJobState,
}: {
  analysisScope: TranslationFlowOptions["analysisScope"];
  chapterId: string;
  pushStatus: UseTranslationActionsOptions["pushStatus"];
  refreshLibrary: UseTranslationActionsOptions["refreshLibrary"];
  setJobState: SetJobState;
}): Promise<boolean> {
  setJobState({
    id: "flow-analysis",
    kind: "gemma-analysis",
    status: "running",
    progressText: "AI 용어/기억 분석 중",
    phase: "model_requesting",
    progressMode: "indeterminate",
  });
  try {
    await mangaGateway.analyzeWorkContext({ chapterId, scope: analysisScope });
    await refreshLibraryWithWarning(refreshLibrary, pushStatus);
    return true;
  } catch (error) {
    console.error(error);
    setJobState({
      id: "flow-analysis-skipped",
      kind: "gemma-analysis",
      status: "completed",
      progressText: "1차 번역 완료 (AI 분석 건너뜀)",
      phase: "done",
    });
    toast.error("AI 용어/기억 분석에 실패해 1차 번역 결과만 유지합니다.");
    return false;
  }
}

export async function runSecondTranslationPass(
  executeAnalysisJob: ExecuteAnalysisJob,
  selection: ChapterRunSelection[],
  pushStatus: UseTranslationActionsOptions["pushStatus"],
  blockMode?: AnalysisBlockMode,
): Promise<void> {
  const pass2 = await runSelectionsSequentially(
    executeAnalysisJob,
    selection.map(toSecondPassSelection),
    pushStatus,
    "2차",
    blockMode,
  );
  if (pass2 === "completed") {
    toast.success("2차 번역까지 완료했습니다.");
  }
}

export function regionTranslationStartingState(): JobState {
  return {
    id: "pending",
    kind: "gemma-analysis",
    status: "starting",
    progressText: "선택 영역 번역 준비 중",
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
): void {
  if (result.status === "completed") {
    reportCompletedRegionTranslation(result, pushStatus, setSelectedBlockId);
    return;
  }
  if (result.status === "failed") {
    failAnalysisJob(
      setJobState,
      pushStatus,
      "선택 영역 번역 실패",
      result.error ?? "선택 영역 번역에 실패했습니다.",
    );
  }
}

function reportCompletedRegionTranslation(
  result: TranslateRegionResult,
  pushStatus: UseTranslationActionsOptions["pushStatus"],
  setSelectedBlockId: UseTranslationActionsOptions["setSelectedBlockId"],
): void {
  if (result.blockIds?.[0]) {
    setSelectedBlockId(result.blockIds[0]);
  }
  const warningSummary = summarizeWarnings(result.warnings ?? []);
  pushStatus(
    warningSummary ||
      `선택 영역에서 ${result.blockIds?.length ?? 0}개 블록을 만들었습니다.`,
  );
}
