import type { TFunction } from "i18next";
import { WORK_CONTEXT_ANALYSIS_CANCELLED_ERROR } from "../../../shared/workContextAnalysisTypes";
import { analysisGateway as mangaGateway } from "../api/analysisGateway";
import type { NotificationPort } from "../lib/notificationPort";
import type { RunAnalysisOutcome } from "./translationFlowHelpers";
import type {
  TranslationFlowOptions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";
import {
  failAnalysisJob,
  refreshLibraryWithWarning,
} from "./translationActionUtils";

type WorkContextFlowOptions = {
  analysisScope: TranslationFlowOptions["analysisScope"];
  chapterId: string;
  pushStatus: UseTranslationActionsOptions["pushStatus"];
  refreshLibrary: UseTranslationActionsOptions["refreshLibrary"];
  setJobState: UseTranslationActionsOptions["setJobState"];
  t?: TFunction<"renderer">;
  notificationPort: NotificationPort;
  deferTerminalFailure?: boolean;
  isCancellationRequested?: () => boolean;
};

export async function runWorkContextAnalysis({
  analysisScope,
  chapterId,
  pushStatus,
  refreshLibrary,
  setJobState,
  t,
  notificationPort,
  deferTerminalFailure = false,
  isCancellationRequested = () => false,
}: WorkContextFlowOptions): Promise<RunAnalysisOutcome> {
  if (isCancellationRequested()) return "cancelled";
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
    if (isCancellationRequested()) return "cancelled";
    await refreshLibraryWithWarning(
      refreshLibrary,
      pushStatus,
      t,
      notificationPort,
    );
    return isCancellationRequested() ? "cancelled" : "completed";
  } catch (error) {
    return resolveContextAnalysisFailure({
      error,
      isCancellationRequested,
      deferTerminalFailure,
      notificationPort,
      pushStatus,
      setJobState,
      t,
    });
  }
}

function resolveContextAnalysisFailure({
  error,
  isCancellationRequested,
  deferTerminalFailure,
  notificationPort,
  pushStatus,
  setJobState,
  t,
}: Pick<
  WorkContextFlowOptions,
  | "deferTerminalFailure"
  | "isCancellationRequested"
  | "notificationPort"
  | "pushStatus"
  | "setJobState"
  | "t"
> & { error: unknown }): RunAnalysisOutcome {
  if (isCancellationRequested?.() || isWorkContextCancellationError(error)) {
    return "cancelled";
  }
  console.error(error);
  const message = t
    ? t("translation.flow.contextFailed")
    : "AI 용어/기억 분석에 실패해 1차 번역 결과만 유지합니다.";
  if (!deferTerminalFailure) {
    failAnalysisJob(
      setJobState,
      pushStatus,
      t ? t("translation.errors.jobFailedTitle") : "번역 작업 실패",
      message,
    );
    notificationPort.error(message);
  } else {
    pushStatus(message);
  }
  return "failed";
}

function isWorkContextCancellationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(WORK_CONTEXT_ANALYSIS_CANCELLED_ERROR)
  );
}
