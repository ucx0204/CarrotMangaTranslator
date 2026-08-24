import { useCallback, type MutableRefObject } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
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
        runPasses: (selection) =>
          runTranslationFlowPasses({
            selection,
            executeAnalysisJob,
            options,
            pushStatus,
            t,
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
  t,
  isCancellationRequested,
}: {
  selection: ChapterRunSelection;
  executeAnalysisJob: ExecuteAnalysisJob;
  options: TranslationFlowOptions;
  pushStatus: UseTranslationActionsOptions["pushStatus"];
  t: TFunction<"renderer">;
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
  const outcome = await runSelectionsSequentially(
    executeAnalysisJob,
    [selection],
    pushStatus,
    t("translation.flow.translation"),
    options.blockMode,
    options.workflowMode === "cumulative",
    naturalTextLayout,
    options.autoFontMatching,
    options.fontSizeAutoFit,
    t,
    completionWorkflow,
    true,
  );
  return outcome === "completed" && isCancellationRequested()
    ? "cancelled"
    : outcome;
}
