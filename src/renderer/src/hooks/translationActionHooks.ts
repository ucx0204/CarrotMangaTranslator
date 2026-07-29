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
  runWorkContextAnalysis,
  startingJobState,
} from "./translationActionUtils";
import { useRunAnalysisAction } from "./useRunAnalysisAction";
import { useTranslateSelectedRegionAction } from "./useTranslateSelectedRegionAction";
import {
  resolveTranslationCompletionOptions,
  runTranslationFlowAction,
} from "./translationBubbleLayoutWorkflow";

type FlowActiveRef = MutableRefObject<boolean>;
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
  job: Parameters<ExecuteAnalysisJob>[0],
  context: AnalysisJobContext,
): Promise<RunAnalysisOutcome> {
  const openChapterId = context.currentChapter?.id;
  const targetChapterId = job.chapterId ?? openChapterId;
  if (!targetChapterId) return "no-op";
  const isOpenChapter = targetChapterId === openChapterId;
  try {
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
    const result = await mangaGateway.startAnalysis(
      makeStartAnalysisRequest(
        targetChapterId,
        {
          runMode: job.runMode,
          pageId: job.pageId,
          pageIds: job.pageIds,
          blockMode: job.blockMode,
          collectPageContext: job.collectPageContext,
          naturalTextLayout: job.naturalTextLayout,
        },
        context.t,
      ),
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
    return resolveStartOutcome(
      result,
      context.setJobState,
      context.pushStatus,
      context.t,
    );
  } catch (error) {
    console.error(error);
    failAnalysisJob(
      context.setJobState,
      context.pushStatus,
      context.t("translation.errors.jobFailedTitle"),
      formatErrorMessage(error, context.t("translation.errors.startFailed")),
    );
    return "failed";
  }
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
        flowActiveRef,
        jobActive,
        mergeLiveChapter,
        naturalTextLayoutDefault,
        notificationPort,
        recordImageEdit,
        refreshLibrary,
        saveNow,
        setFlowActive,
        setShowBlockChrome,
        t,
        runPasses: (chapter) =>
          runTranslationFlowPasses({
            chapterId: chapter.id,
            selection: options.selection,
            executeAnalysisJob,
            options,
            pushStatus,
            refreshLibrary,
            setJobState,
            t,
            notificationPort,
          }),
      }),
    [
      currentChapter,
      clearPageImageCache,
      clearRetouchHistory,
      executeAnalysisJob,
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
  chapterId,
  selection,
  executeAnalysisJob,
  options,
  pushStatus,
  refreshLibrary,
  setJobState,
  t,
  notificationPort,
}: {
  chapterId: string;
  selection: ChapterRunSelection[];
  executeAnalysisJob: ExecuteAnalysisJob;
  options: TranslationFlowOptions;
  pushStatus: UseTranslationActionsOptions["pushStatus"];
  refreshLibrary: UseTranslationActionsOptions["refreshLibrary"];
  setJobState: UseTranslationActionsOptions["setJobState"];
  t: TFunction<"renderer">;
  notificationPort: NotificationPort;
}): Promise<RunAnalysisOutcome> {
  // Bubble layout is resolved only after inpainting, against a render region
  // that can be much larger than the OCR bbox. Baking hard line breaks before
  // that step would preserve stale narrow-bbox wrapping inside the final
  // shape-aware layout, so let the Bubble renderer own wrapping in this
  // combined workflow.
  const completion = resolveTranslationCompletionOptions(options);
  const naturalTextLayout = completion.bubbleLayout
    ? undefined
    : options.naturalTextLayout;
  const pass1 = await runSelectionsSequentially(
    executeAnalysisJob,
    selection,
    pushStatus,
    t("translation.flow.firstPass"),
    options.blockMode,
    options.workflowMode === "cumulative",
    naturalTextLayout,
    t,
  );
  if (pass1 !== "completed") {
    return pass1;
  }
  if (options.workflowMode !== "two-pass") {
    notificationPort.success(t("translation.flow.completed"));
    return "completed";
  }
  const contextReady = await runWorkContextAnalysis({
    analysisScope: options.analysisScope,
    chapterId,
    pushStatus,
    refreshLibrary,
    setJobState,
    t,
    notificationPort,
  });
  if (!contextReady) {
    return "failed";
  }
  return runSecondTranslationPass(
    executeAnalysisJob,
    selection,
    pushStatus,
    options.blockMode,
    naturalTextLayout,
    t,
    notificationPort,
  );
}
