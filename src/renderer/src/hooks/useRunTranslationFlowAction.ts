import { useCallback, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { NotificationPort } from "../lib/notificationPort";
import type { ChapterRunSelection } from "../lib/translationSelection";
import {
  runSelectionsSequentially,
  type ExecuteAnalysisJob,
  type RunAnalysisOutcome,
} from "./translationFlowHelpers";
import type {
  TranslationActions,
  TranslationFlowOptions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";
import { runSecondTranslationPass } from "./translationActionUtils";
import { runWorkContextAnalysis } from "./translationWorkContextFlow";
import { runTranslationFlowAction } from "./translationBubbleLayoutWorkflow";
import { resolveTranslationCompletionOptions } from "./translationBubbleLayoutWorkflowSupport";

export function useRunTranslationFlowAction({
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
  flowActiveRef: MutableRefObject<boolean>;
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
  // that can be much larger than the OCR bbox. Let the Bubble renderer own
  // wrapping instead of preserving stale narrow-bbox line breaks.
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
  if (pass1 !== "completed") return pass1;
  if (isCancellationRequested()) return "cancelled";
  if (options.workflowMode !== "two-pass") return "completed";
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
  return runSecondTranslationPass(
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
}
