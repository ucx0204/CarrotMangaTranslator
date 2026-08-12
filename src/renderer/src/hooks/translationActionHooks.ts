import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { analysisGateway as mangaGateway } from "../api/analysisGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import { markChapterPagesRunning } from "../lib/chapterSync";
import type { NotificationPort } from "../lib/notificationPort";
import type { ChapterRunSelection } from "../lib/translationSelection";
import type {
  ExecuteAnalysisJob,
  RunAnalysisOutcome,
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
  startingJobState,
} from "./translationActionUtils";
import { useRunAnalysisAction } from "./useRunAnalysisAction";
import { useTranslateSelectedRegionAction } from "./useTranslateSelectedRegionAction";
import { hashTranslationBlocks } from "../../../shared/blockFingerprint";
import { useRunTranslationFlowAction } from "./useRunTranslationFlowAction";

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
  const rawRunTranslationFlow = useRunTranslationFlowAction({
    ...options,
    executeAnalysisJob,
    flowActiveRef,
    notificationPort,
  });
  const rawRunAnalysis = useRunAnalysisAction({
    currentChapter: options.currentChapter,
    executeAnalysisJob,
    flowActiveRef,
    jobActive: options.jobActive,
    translationWorkflowDefault:
      options.translationWorkflowDefault ?? "cumulative",
    autoFontMatchingDefault: options.autoFontMatchingDefault ?? false,
    naturalTextLayoutDefault: options.naturalTextLayoutDefault ?? true,
  });
  const runAnalysis = useCheckpointedRunAnalysis(rawRunAnalysis, options);
  const runTranslationFlow = useCheckpointedTranslationFlow(
    rawRunTranslationFlow,
    options,
  );
  const translateSelectedRegion = useTranslateSelectedRegionAction(
    options,
    notificationPort,
  );

  return { runAnalysis, runTranslationFlow, translateSelectedRegion };
}

function useCheckpointedRunAnalysis(
  runAnalysis: TranslationActions["runAnalysis"],
  options: UseTranslationActionsOptions,
): TranslationActions["runAnalysis"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (...args: Parameters<TranslationActions["runAnalysis"]>) => {
      const before = options.currentChapterRef.current;
      const pageIds = before
        ? resolveDirectCheckpointPageIds(before, args[0], args[1], args[2])
        : [];
      const outcome = await runAnalysis(...args);
      recordTranslationCheckpoint({ before, pageIds, options, t });
      return outcome;
    },
    [options, runAnalysis, t],
  );
}

function useCheckpointedTranslationFlow(
  runTranslationFlow: TranslationActions["runTranslationFlow"],
  options: UseTranslationActionsOptions,
): TranslationActions["runTranslationFlow"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (flowOptions: TranslationFlowOptions) => {
      const before = options.currentChapterRef.current;
      const pageIds = before
        ? resolveFlowCheckpointPageIds(before, flowOptions.selection)
        : [];
      const outcome = await runTranslationFlow(flowOptions);
      recordTranslationCheckpoint({ before, pageIds, options, t });
      return outcome;
    },
    [options, runTranslationFlow, t],
  );
}

function recordTranslationCheckpoint({
  before,
  options,
  pageIds,
  t,
}: {
  before: ChapterSnapshot | null;
  options: UseTranslationActionsOptions;
  pageIds: string[];
  t: TFunction<"renderer">;
}): void {
  const after = options.currentChapterRef.current;
  if (
    !before ||
    !after ||
    before.id !== after.id ||
    pageIds.length === 0 ||
    !options.recordTranslationCheckpoint ||
    !checkpointBlocksChanged(before, after, pageIds)
  ) {
    return;
  }
  const retranslation = pageIds.some(
    (pageId) =>
      (before.pages.find((page) => page.id === pageId)?.blocks.length ?? 0) > 0,
  );
  options.recordTranslationCheckpoint({
    before,
    after,
    pageIds,
    label: t(
      retranslation
        ? "workspaceHistory.retranslationCheckpoint"
        : "workspaceHistory.translationCheckpoint",
    ),
  });
}

function checkpointBlocksChanged(
  before: ChapterSnapshot,
  after: ChapterSnapshot,
  pageIds: string[],
): boolean {
  const afterPages = new Map(after.pages.map((page) => [page.id, page]));
  return pageIds.some((pageId) => {
    const beforePage = before.pages.find((page) => page.id === pageId);
    const afterPage = afterPages.get(pageId);
    return Boolean(
      beforePage &&
      afterPage &&
      hashTranslationBlocks(beforePage.blocks) !==
        hashTranslationBlocks(afterPage.blocks),
    );
  });
}

function resolveDirectCheckpointPageIds(
  chapter: ChapterSnapshot,
  runMode: RunAnalysisMode,
  pageId?: string,
  chapterId?: string,
): string[] {
  if (chapterId && chapterId !== chapter.id) return [];
  if (runMode === "single-page") return pageId ? [pageId] : [];
  if (runMode === "page-set") return pageId ? [pageId] : [];
  if (runMode === "all") return [...chapter.pageOrder];
  return chapter.pages
    .filter((page) => page.analysisStatus !== "completed")
    .map((page) => page.id);
}

function resolveFlowCheckpointPageIds(
  chapter: ChapterSnapshot,
  selections: ChapterRunSelection[],
): string[] {
  const selection = selections.find(
    (candidate) => candidate.chapterId === chapter.id,
  );
  if (!selection) return [];
  if (selection.mode === "page-set") return [...selection.pageIds];
  if (selection.mode === "all") return [...chapter.pageOrder];
  return chapter.pages
    .filter((page) => page.analysisStatus !== "completed")
    .map((page) => page.id);
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
