import { useCallback, useRef, type MutableRefObject } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { NotificationPort } from "../lib/notificationPort";
import type { ChapterRunSelection } from "../lib/translationSelection";
import type { JobFailureGuidance } from "../../../shared/jobTypes";
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
import { runTranslationFlowAction } from "./translationBubbleLayoutWorkflow";
import { resolveTranslationCompletionOptions } from "./translationBubbleLayoutWorkflowSupport";
import type { PageTimingSessionRef } from "../../../shared/pageProcessingTiming";

type TranslationPassRunnerConfig = Pick<
  UseTranslationActionsOptions,
  "flowCancellationRef" | "pushStatus"
> & {
  executeAnalysisJob: ExecuteAnalysisJob;
  failureGuidanceRef: MutableRefObject<JobFailureGuidance | undefined>;
  options: TranslationFlowOptions;
  t: TFunction<"renderer">;
};

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
  const failureGuidanceRef = useRef<JobFailureGuidance | undefined>(undefined);
  return useCallback(
    (options: TranslationFlowOptions) =>
      runTranslationFlowAction(options, {
        clearPageImageCache,
        clearRetouchHistory,
        currentChapter,
        flowCancellationRef,
        flowActiveRef,
        failureGuidanceRef,
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
        runPasses: createTranslationPassRunner({
          executeAnalysisJob,
          failureGuidanceRef,
          flowCancellationRef,
          options,
          pushStatus,
          t,
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

function createTranslationPassRunner({
  executeAnalysisJob,
  failureGuidanceRef,
  flowCancellationRef,
  options,
  pushStatus,
  t,
}: TranslationPassRunnerConfig): (
  selection: ChapterRunSelection,
  timingSession: PageTimingSessionRef,
) => Promise<RunAnalysisOutcome> {
  return (selection, timingSession) =>
    runTranslationFlowPasses({
      selection,
      executeAnalysisJob,
      options,
      pushStatus,
      t,
      timingSession,
      isCancellationRequested: () => flowCancellationRef?.current === true,
      onFailureGuidance: (guidance) => {
        failureGuidanceRef.current = guidance;
      },
    });
}

async function runTranslationFlowPasses({
  selection,
  executeAnalysisJob,
  options,
  pushStatus,
  t,
  isCancellationRequested,
  onFailureGuidance,
  timingSession,
}: {
  selection: ChapterRunSelection;
  executeAnalysisJob: ExecuteAnalysisJob;
  options: TranslationFlowOptions;
  pushStatus: UseTranslationActionsOptions["pushStatus"];
  t: TFunction<"renderer">;
  isCancellationRequested: () => boolean;
  onFailureGuidance: (guidance: JobFailureGuidance) => void;
  timingSession: PageTimingSessionRef;
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
  const outcome = await runSelectionsSequentially(
    executeAnalysisJob,
    [selection],
    pushStatus,
    t("translation.flow.translation"),
    options.blockMode,
    options.workflowMode === "cumulative",
    naturalTextLayout,
    options.autoFontMatching,
    options.aiFontSizeMatching,
    t,
    completionWorkflow,
    true,
    onFailureGuidance,
    options.cumulativeContextDetail,
    timingSession,
  );
  return outcome === "completed" && isCancellationRequested()
    ? "cancelled"
    : outcome;
}
