import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { analysisGateway as mangaGateway } from "../api/analysisGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import { markChapterPagesRunning } from "../lib/chapterSync";
import type { NotificationPort } from "../lib/notificationPort";
import type { ChapterRunSelection } from "../lib/translationSelection";
import {
  runSelectionsSequentially,
  type ExecuteAnalysisJob,
  type RunAnalysisOutcome,
} from "./translationFlowHelpers";
import type {
  RunAnalysisMode,
  TranslationActions,
  TranslationFlowOptions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";
import {
  failAnalysisJob,
  makeStartAnalysisRequest,
  refreshLibraryWithWarning,
  reportRefreshLibraryFailure,
  resolveStartOutcome,
  runSecondTranslationPass,
  startingJobState,
} from "./translationActionUtils";
import { runWorkContextAnalysis } from "./translationWorkContextFlow";
import { useRunAnalysisAction } from "./useRunAnalysisAction";
import { useTranslateSelectedRegionAction } from "./useTranslateSelectedRegionAction";
import { runTranslationFlowAction } from "./translationBubbleLayoutWorkflow";
import { resolveTranslationCompletionOptions } from "./translationBubbleLayoutWorkflowSupport";

type FlowActiveRef = MutableRefObject<boolean>;
type AnalysisJob = Parameters<ExecuteAnalysisJob>[0];
type StartResult = Awaited<ReturnType<typeof mangaGateway.startAnalysis>>;
type AnalysisJobContext = Pick<
  UseTranslationActionsOptions,
  | "beforeTranslate"
  | "clearStatusLines"
  | "currentChapter"
  | "currentChapterRef"
  | "mergeLiveChapter"
  | "pushStatus"
  | "refreshLibrary"
  | "saveNow"
  | "setCurrentChapter"
  | "setJobState"
> & {
  notificationPort: NotificationPort;
  t: TFunction<"renderer">;
};
export { reportRefreshLibraryFailure };

export function useTranslationActionsImpl(
  options: UseTranslationActionsOptions,
  notificationPort: NotificationPort,
): TranslationActions {
  const flowActiveRef = useRef(false);
  const executeAnalysisJob = useExecuteAnalysisJob(options, notificationPort);
  const runTranslationFlow = useRunTranslationFlowAction({
    ...options,
    executeAnalysisJob,
    flowActiveRef,
    notificationPort,
  });
  const runAnalysis = useRunAnalysisAction({
    currentChapter: options.currentChapter,
    executeAnalysisJob,
    flowActiveRef,
    jobActive: options.jobActive,
    runTranslationFlow,
    translationWorkflowDefault:
      options.translationWorkflowDefault ?? "cumulative",
    analysisScopeDefault: options.analysisScopeDefault ?? "missing",
    blockModeDefault: options.blockModeDefault ?? "auto",
    autoFontMatchingDefault: options.autoFontMatchingDefault ?? false,
    naturalTextLayoutDefault: options.naturalTextLayoutDefault ?? true,
  });
  const translateSelectedRegion = useTranslateSelectedRegionAction(
    options,
    notificationPort,
  );

  return { runAnalysis, runTranslationFlow, translateSelectedRegion };
}

function useExecuteAnalysisJob(
  {
    beforeTranslate,
    clearStatusLines,
    currentChapter,
    currentChapterRef,
    mergeLiveChapter,
    pushStatus,
    refreshLibrary,
    saveNow,
    setCurrentChapter,
    setJobState,
  }: UseTranslationActionsOptions,
  notificationPort: NotificationPort,
): ExecuteAnalysisJob {
  const { t } = useTranslation("renderer");
  const context = useMemo<AnalysisJobContext>(
    () => ({
      beforeTranslate,
      clearStatusLines,
      currentChapter,
      currentChapterRef,
      mergeLiveChapter,
      notificationPort,
      pushStatus,
      refreshLibrary,
      saveNow,
      setCurrentChapter,
      setJobState,
      t,
    }),
    [
      beforeTranslate,
      clearStatusLines,
      currentChapter,
      currentChapterRef,
      mergeLiveChapter,
      notificationPort,
      pushStatus,
      refreshLibrary,
      saveNow,
      setCurrentChapter,
      setJobState,
      t,
    ],
  );
  return useCallback<ExecuteAnalysisJob>(
    (job) => executeAnalysisJob(job, context),
    [context],
  );
}

async function executeAnalysisJob(
  job: AnalysisJob,
  context: AnalysisJobContext,
): Promise<RunAnalysisOutcome> {
  const openChapterId = context.currentChapter?.id;
  const targetChapterId = job.chapterId ?? openChapterId;
  if (!targetChapterId) return "no-op";
  const isOpenChapter = targetChapterId === openChapterId;
  try {
    await prepareAnalysisJob(job, context, isOpenChapter);
    const result = await mangaGateway.startAnalysis(
      makeStartAnalysisRequest(targetChapterId, job, context.t),
    );
    if (result.chapter && result.chapter.id === openChapterId) {
      context.mergeLiveChapter(result.chapter);
    }
    await refreshLibraryWithWarning(
      context.refreshLibrary,
      context.pushStatus,
      context.t,
      context.notificationPort,
    );
    return resolveAnalysisJobOutcome(result, job, context);
  } catch (error) {
    return handleAnalysisJobError(error, job.deferTerminalFailure, context);
  }
}

async function prepareAnalysisJob(
  job: AnalysisJob,
  context: AnalysisJobContext,
  isOpenChapter: boolean,
): Promise<void> {
  if (isOpenChapter) await context.saveNow();
  await context.beforeTranslate?.();
  context.clearStatusLines();
  context.setJobState(startingJobState(context.t));
  markOpenChapterRunning({
    currentChapter: isOpenChapter ? context.currentChapter : null,
    currentChapterRef: context.currentChapterRef,
    pageId: job.pageId,
    pageIds: job.pageIds,
    runMode: job.runMode,
    setCurrentChapter: context.setCurrentChapter,
  });
}

function resolveAnalysisJobOutcome(
  result: StartResult,
  job: AnalysisJob,
  context: AnalysisJobContext,
): RunAnalysisOutcome {
  if (!job.deferTerminalFailure || result.status === "completed") {
    return resolveStartOutcome(
      result,
      context.setJobState,
      context.pushStatus,
      context.t,
    );
  }
  if (result.status === "cancelled") return "cancelled";
  if (result.error) console.error(result.error);
  return "failed";
}

function handleAnalysisJobError(
  error: unknown,
  deferTerminalFailure: boolean | undefined,
  context: AnalysisJobContext,
): "failed" {
  console.error(error);
  if (!deferTerminalFailure) {
    failAnalysisJob(
      context.setJobState,
      context.pushStatus,
      context.t("translation.errors.jobFailedTitle"),
      formatErrorMessage(error, context.t("translation.errors.startFailed")),
    );
  }
  return "failed";
}

function markOpenChapterRunning({
  currentChapter,
  currentChapterRef,
  pageId,
  pageIds,
  runMode,
  setCurrentChapter,
}: {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  pageId?: string;
  pageIds?: string[];
  runMode: RunAnalysisMode;
  setCurrentChapter: UseTranslationActionsOptions["setCurrentChapter"];
}): void {
  if (!currentChapter) {
    return;
  }
  const optimisticChapter = markChapterPagesRunning(
    currentChapter,
    runMode,
    pageId,
    pageIds,
  );
  currentChapterRef.current = optimisticChapter;
  setCurrentChapter(optimisticChapter);
}

function useRunTranslationFlowAction({
  clearPageImageCache,
  clearRetouchHistory,
  currentChapter,
  executeAnalysisJob,
  flowCancellationRef,
  flowActiveRef,
  jobActive,
  mergeLiveChapter,
  naturalTextLayoutDefault,
  pushStatus,
  refreshLibrary,
  recordImageEdit,
  saveNow,
  setFlowActive,
  setShowBlockChrome,
  setJobState,
  notificationPort,
}: UseTranslationActionsOptions & {
  executeAnalysisJob: ExecuteAnalysisJob;
  flowActiveRef: FlowActiveRef;
  notificationPort: NotificationPort;
}): TranslationActions["runTranslationFlow"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    (options: TranslationFlowOptions) =>
      runTranslationFlowAction(options, {
        clearPageImageCache,
        clearRetouchHistory,
        currentChapter,
        flowCancellationRef,
        flowActiveRef,
        jobActive,
        mergeLiveChapter,
        naturalTextLayoutDefault,
        notificationPort,
        pushStatus,
        recordImageEdit,
        refreshLibrary,
        saveNow,
        setFlowActive,
        setShowBlockChrome,
        setJobState,
        t,
        runPasses: (selection, analysisScope) =>
          runTranslationFlowPasses({
            selection,
            executeAnalysisJob,
            options: { ...options, analysisScope },
            pushStatus,
            refreshLibrary,
            setJobState,
            t,
            notificationPort,
            isCancellationRequested: () =>
              flowCancellationRef?.current === true,
          }),
      }),
    [
      currentChapter,
      clearPageImageCache,
      clearRetouchHistory,
      executeAnalysisJob,
      flowCancellationRef,
      flowActiveRef,
      jobActive,
      mergeLiveChapter,
      naturalTextLayoutDefault,
      notificationPort,
      pushStatus,
      refreshLibrary,
      recordImageEdit,
      saveNow,
      setFlowActive,
      setShowBlockChrome,
      setJobState,
      t,
    ],
  );
}

async function runTranslationFlowPasses({
  selection,
  executeAnalysisJob,
  options,
  pushStatus,
  refreshLibrary,
  setJobState,
  t,
  notificationPort,
  isCancellationRequested,
}: {
  selection: ChapterRunSelection;
  executeAnalysisJob: ExecuteAnalysisJob;
  options: TranslationFlowOptions;
  pushStatus: UseTranslationActionsOptions["pushStatus"];
  refreshLibrary: UseTranslationActionsOptions["refreshLibrary"];
  setJobState: UseTranslationActionsOptions["setJobState"];
  t: TFunction<"renderer">;
  notificationPort: NotificationPort;
  isCancellationRequested: () => boolean;
}): Promise<RunAnalysisOutcome> {
  // Bubble layout is resolved only after inpainting, against a render region
  // that can be much larger than the OCR bbox. Baking hard line breaks before
  // that step would preserve stale narrow-bbox wrapping inside the final
  // shape-aware layout, so let the Bubble renderer own wrapping in this
  // combined workflow.
  const completion = resolveTranslationCompletionOptions(options);
  const completionWorkflow = completion.eraseOriginal
    ? completion.bubbleLayout
      ? ("bubble-layout" as const)
      : ("erase-original" as const)
    : undefined;
  const naturalTextLayout = completion.bubbleLayout
    ? undefined
    : options.naturalTextLayout;
  const pass1 = await runSelectionsSequentially(
    executeAnalysisJob,
    [selection],
    pushStatus,
    t("translation.flow.firstPass"),
    options.blockMode,
    options.workflowMode === "cumulative",
    naturalTextLayout,
    options.autoFontMatching,
    t,
    completionWorkflow,
    true,
  );
  if (pass1 !== "completed") {
    return pass1;
  }
  if (isCancellationRequested()) return "cancelled";
  if (options.workflowMode !== "two-pass") {
    return "completed";
  }
  const contextOutcome = await runWorkContextAnalysis({
    analysisScope: options.analysisScope,
    chapterId: selection.chapterId,
    pushStatus,
    refreshLibrary,
    setJobState,
    t,
    notificationPort,
    deferTerminalFailure: true,
    isCancellationRequested,
  });
  if (contextOutcome !== "completed") return contextOutcome;
  if (isCancellationRequested()) return "cancelled";
  const pass2 = await runSecondTranslationPass(
    executeAnalysisJob,
    [selection],
    pushStatus,
    options.blockMode,
    naturalTextLayout,
    options.autoFontMatching,
    t,
    notificationPort,
    completionWorkflow,
    true,
  );
  return pass2;
}
