import type { TFunction } from "i18next";
import type { MutableRefObject } from "react";
import type {
  AutoInpaintingChapterSelection,
  InpaintingPostprocessOptions,
} from "../../../shared/inpaintingTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { WorkContextAnalysisScope } from "../../../shared/workContextAnalysisTypes";
import type { NotificationPort } from "../lib/notificationPort";
import type { ChapterRunSelection } from "../lib/translationSelection";
import { runInpaintingSelectionsSequentially } from "./inpaintingSelectionFlow";
import type { RunAnalysisOutcome } from "./translationFlowHelpers";
import type {
  TranslationFlowOptions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";
import { resolveTranslationChapterSelections } from "./translationChapterSelections";
import {
  applyTranslationInpaintingResult,
  refreshTranslationLibrary,
  resolveNaturalTextLayout,
  resolveTranslationCompletionOptions,
} from "./translationBubbleLayoutWorkflowSupport";

type TranslationFlowActionContext = Pick<
  UseTranslationActionsOptions,
  | "clearPageImageCache"
  | "clearRetouchHistory"
  | "currentChapter"
  | "flowCancellationRef"
  | "jobActive"
  | "mergeLiveChapter"
  | "naturalTextLayoutDefault"
  | "pushStatus"
  | "recordImageEdit"
  | "refreshLibrary"
  | "saveNow"
  | "setFlowActive"
  | "setShowBlockChrome"
  | "setJobState"
> & {
  flowActiveRef: MutableRefObject<boolean>;
  notificationPort: NotificationPort;
  runPasses: (
    selection: ChapterRunSelection,
    analysisScope: WorkContextAnalysisScope,
  ) => Promise<RunAnalysisOutcome>;
  t: TFunction<"renderer">;
};

type FlowAggregate = {
  anyAttempted: boolean;
  anyFailed: boolean;
  anyPartial: boolean;
  firstError?: string;
};

type TranslationCompletion = ReturnType<
  typeof resolveTranslationCompletionOptions
>;

type FlowExecution = {
  options: TranslationFlowOptions;
  context: TranslationFlowActionContext;
  currentChapter: ChapterSnapshot;
  completion: TranslationCompletion;
  naturalTextLayout: boolean;
};

type ChapterFlowResult =
  | {
      status: "continue";
      attempted: boolean;
      failed: boolean;
      partial: boolean;
      error?: string;
    }
  | {
      status: "cancelled";
      inpainting: boolean;
      refreshLibrary: boolean;
    };

const FLOW_MESSAGE_KEYS = {
  completed: [
    "translation.flow.completed",
    "translation.eraseOriginalWorkflowCompleted",
    "translation.bubbleLayoutWorkflowCompleted",
  ],
  failed: [
    "translation.errors.jobFailed",
    "translation.eraseOriginalWorkflowFailed",
    "translation.bubbleLayoutWorkflowFailed",
  ],
  partial: [
    "translation.flow.partial",
    "translation.eraseOriginalWorkflowPartial",
    "translation.bubbleLayoutWorkflowPartial",
  ],
} as const;

export async function runTranslationFlowAction(
  options: TranslationFlowOptions,
  context: TranslationFlowActionContext,
): Promise<RunAnalysisOutcome> {
  const currentChapter = context.currentChapter;
  if (
    !currentChapter ||
    context.jobActive ||
    context.flowActiveRef.current ||
    options.selection.length === 0
  ) {
    return "no-op";
  }
  const completion = resolveTranslationCompletionOptions(options);
  const naturalTextLayout = resolveNaturalTextLayout(
    options.naturalTextLayout,
    context.naturalTextLayoutDefault,
  );
  context.flowActiveRef.current = true;
  if (context.flowCancellationRef) {
    context.flowCancellationRef.current = false;
  }
  context.setFlowActive(true);
  try {
    return await executeTranslationFlow({
      options,
      context,
      currentChapter,
      completion,
      naturalTextLayout,
    });
  } catch (error) {
    return failTranslationFlow(error, completion, context);
  } finally {
    context.flowActiveRef.current = false;
    context.setFlowActive(false);
  }
}

async function executeTranslationFlow(
  execution: FlowExecution,
): Promise<RunAnalysisOutcome> {
  const { completion, context, options } = execution;
  const aggregate: FlowAggregate = {
    anyAttempted: false,
    anyFailed: false,
    anyPartial: false,
  };
  await context.saveNow();
  if (isFlowCancellationRequested(context)) {
    return finishCancelledFlow(context, completion.eraseOriginal);
  }
  for (let index = 0; index < options.selection.length; index += 1) {
    if (isFlowCancellationRequested(context)) {
      return finishCancelledFlow(context, completion.eraseOriginal);
    }
    const result = await runTranslationChapter(execution, index);
    if (result.status === "cancelled") {
      if (result.refreshLibrary) await refreshTranslationLibrary(context);
      return finishCancelledFlow(context, result.inpainting);
    }
    mergeChapterFlowResult(aggregate, result);
    if (result.failed) break;
  }
  if (completion.eraseOriginal) await refreshTranslationLibrary(context);
  if (isFlowCancellationRequested(context)) {
    return finishCancelledFlow(context, completion.eraseOriginal);
  }
  return finishTranslationFlow(aggregate, completion, context);
}

async function runTranslationChapter(
  execution: FlowExecution,
  index: number,
): Promise<ChapterFlowResult> {
  const { completion, context, options } = execution;
  const selection = options.selection[index];
  reportChapterProgress(index, options.selection.length, context);
  const selections = await resolveTranslationChapterSelections(
    selection,
    options.workflowMode,
    completion,
  );
  if (isFlowCancellationRequested(context)) {
    return {
      status: "cancelled",
      inpainting: completion.eraseOriginal,
      refreshLibrary: false,
    };
  }
  const translationOutcome = await context.runPasses(
    selections.analysis,
    resolvePerChapterAnalysisScope(options.analysisScope, index),
  );
  if (isFlowCancellationRequested(context)) {
    return {
      status: "cancelled",
      inpainting: completion.eraseOriginal,
      refreshLibrary: false,
    };
  }
  const translationResult = resolveTranslationChapterResult(
    translationOutcome,
    completion,
  );
  if (translationResult) return translationResult;
  if (!selections.inpainting) {
    return continuationResult(translationOutcome === "completed", false);
  }
  const inpaintingResult = await runTranslationInpaintingChapter(
    selections.inpainting,
    execution,
  );
  if (
    inpaintingResult.status === "cancelled" ||
    isFlowCancellationRequested(context)
  ) {
    return { status: "cancelled", inpainting: true, refreshLibrary: true };
  }
  return continuationResult(
    true,
    inpaintingResult.status === "failed",
    inpaintingResult.error,
    inpaintingResult.status === "partial",
  );
}

function resolveTranslationChapterResult(
  outcome: RunAnalysisOutcome,
  completion: TranslationCompletion,
): ChapterFlowResult | null {
  if (outcome === "cancelled") {
    return {
      status: "cancelled",
      inpainting: completion.eraseOriginal,
      refreshLibrary: false,
    };
  }
  if (outcome === "failed") return continuationResult(true, true);
  if (outcome === "partial") {
    return continuationResult(true, false, undefined, true);
  }
  return null;
}

function continuationResult(
  attempted: boolean,
  failed: boolean,
  error?: string,
  partial = false,
): ChapterFlowResult {
  return { status: "continue", attempted, failed, partial, error };
}

function mergeChapterFlowResult(
  aggregate: FlowAggregate,
  result: Extract<ChapterFlowResult, { status: "continue" }>,
): void {
  if (result.attempted) aggregate.anyAttempted = true;
  if (result.failed) aggregate.anyFailed = true;
  if (result.partial) aggregate.anyPartial = true;
  if (!aggregate.firstError && result.error)
    aggregate.firstError = result.error;
}

function failTranslationFlow(
  error: unknown,
  completion: TranslationCompletion,
  context: TranslationFlowActionContext,
): "failed" {
  console.error(error);
  const fallback = context.t(resolveFlowMessageKey(completion, "failed"));
  const message =
    error instanceof Error && error.message.trim() ? error.message : fallback;
  setFlowTerminal(context, "failed", fallback, message);
  context.notificationPort.error(message);
  return "failed";
}

function resolveFlowMessageKey(
  completion: TranslationCompletion,
  status: "completed" | "partial" | "failed",
) {
  const workflowIndex = !completion.eraseOriginal
    ? 0
    : completion.bubbleLayout
      ? 2
      : 1;
  return FLOW_MESSAGE_KEYS[status][workflowIndex];
}

function resolvePerChapterAnalysisScope(
  requested: WorkContextAnalysisScope,
  chapterIndex: number,
): WorkContextAnalysisScope {
  // A work-wide two-pass flow must not put a global pass-1 barrier between
  // chapters. Analyze what is currently available for the first chapter, then
  // only fill missing work context as later chapters finish pass 1.
  return requested === "work" && chapterIndex > 0 ? "missing" : requested;
}

async function runTranslationInpaintingChapter(
  selection: AutoInpaintingChapterSelection,
  execution: FlowExecution,
) {
  const { completion, currentChapter, naturalTextLayout } = execution;
  const postprocess: InpaintingPostprocessOptions = {
    bubbleLayout: {
      enabled: completion.bubbleLayout,
      policy: "balanced",
      ...(completion.bubbleLayout && naturalTextLayout
        ? { naturalTextLayout: true }
        : {}),
    },
  };
  return runInpaintingSelectionsSequentially({
    workId: currentChapter.workId,
    selections: [selection],
    postprocess,
    shouldCancel: () => isFlowCancellationRequested(execution.context),
    onResult: (result) =>
      applyTranslationInpaintingResult(
        result,
        selection,
        currentChapter,
        execution.context,
      ),
  });
}

function isFlowCancellationRequested(
  context: Pick<TranslationFlowActionContext, "flowCancellationRef">,
): boolean {
  return context.flowCancellationRef?.current === true;
}

function finishTranslationFlow(
  aggregate: FlowAggregate,
  completion: { eraseOriginal: boolean; bubbleLayout: boolean },
  context: TranslationFlowActionContext,
): RunAnalysisOutcome {
  if (!aggregate.anyAttempted) return "no-op";
  if (aggregate.anyFailed) {
    const fallback = context.t(resolveFlowMessageKey(completion, "failed"));
    const message = aggregate.firstError?.trim() || fallback;
    setFlowTerminal(context, "failed", fallback, message);
    context.notificationPort.error(message);
    return "failed";
  }
  if (aggregate.anyPartial) {
    const message = context.t(resolveFlowMessageKey(completion, "partial"));
    setFlowTerminal(context, "partial", message, message);
    context.notificationPort.warn(message);
    return "partial";
  }

  const message = context.t(resolveFlowMessageKey(completion, "completed"));
  setFlowTerminal(context, "completed", message);
  if (completion.eraseOriginal) {
    context.setShowBlockChrome(false);
  }
  context.notificationPort.success(message);
  return "completed";
}

function finishCancelledFlow(
  context: TranslationFlowActionContext,
  inpainting: boolean,
): "cancelled" {
  context.setJobState({
    id: "translation-flow-cancelled",
    kind: inpainting ? "inpainting" : "gemma-analysis",
    status: "cancelled",
    progressText: context.t("job.phase.cancelled"),
    phase: "cancelled",
  });
  return "cancelled";
}

function setFlowTerminal(
  context: TranslationFlowActionContext,
  status: "completed" | "partial" | "failed",
  progressText: string,
  detail?: string,
): void {
  context.setJobState({
    id: `translation-flow-${status}`,
    kind: status === "partial" ? "inpainting" : "gemma-analysis",
    status,
    progressText,
    phase:
      status === "completed"
        ? "done"
        : status === "partial"
          ? "partial"
          : "failed",
    ...(detail ? { detail } : {}),
  });
  if (detail) context.pushStatus(detail);
}

function reportChapterProgress(
  index: number,
  total: number,
  context: TranslationFlowActionContext,
): void {
  if (total <= 1) return;
  context.pushStatus(
    context.t("translation.flow.chapterProgress", {
      pass: context.t("translation.flow.firstPass"),
      current: index + 1,
      total,
    }),
  );
}
