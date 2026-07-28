import type { TFunction } from "i18next";
import type { MutableRefObject } from "react";
import type { AutoInpaintingChapterSelection } from "../../../shared/inpaintingTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { inpaintingGateway } from "../api/inpaintingGateway";
import { libraryGateway } from "../api/libraryGateway";
import type { NotificationPort } from "../lib/notificationPort";
import type { ChapterRunSelection } from "../lib/translationSelection";
import type { RunAnalysisOutcome } from "./translationFlowHelpers";
import type {
  TranslationFlowOptions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";

export async function resolveTranslationInpaintingSelections(
  selection: ChapterRunSelection[],
): Promise<AutoInpaintingChapterSelection[]> {
  const resolved = await Promise.all(
    selection.map(async (item) => {
      if (item.mode !== "pending") {
        return item;
      }
      const chapter = await libraryGateway.openChapter(item.chapterId);
      const pageIds = chapter.pages
        .filter((page) => page.analysisStatus !== "completed")
        .map((page) => page.id);
      return pageIds.length > 0
        ? {
            chapterId: item.chapterId,
            mode: "page-set" as const,
            pageIds,
          }
        : null;
    }),
  );
  return resolved.filter(
    (item): item is AutoInpaintingChapterSelection => item !== null,
  );
}

type TranslationFlowActionContext = Pick<
  UseTranslationActionsOptions,
  | "clearPageImageCache"
  | "clearRetouchHistory"
  | "currentChapter"
  | "jobActive"
  | "mergeLiveChapter"
  | "recordImageEdit"
  | "refreshLibrary"
  | "saveNow"
  | "setFlowActive"
  | "setShowBlockChrome"
> & {
  flowActiveRef: MutableRefObject<boolean>;
  notificationPort: NotificationPort;
  runPasses: (chapter: ChapterSnapshot) => Promise<RunAnalysisOutcome>;
  t: TFunction<"renderer">;
};

export async function runTranslationFlowAction(
  options: TranslationFlowOptions,
  context: TranslationFlowActionContext,
): Promise<RunAnalysisOutcome> {
  const chapter = context.currentChapter;
  if (
    !chapter ||
    context.jobActive ||
    context.flowActiveRef.current ||
    options.selection.length === 0
  ) {
    return "no-op";
  }
  const completion = resolveTranslationCompletionOptions(options);
  context.flowActiveRef.current = true;
  context.setFlowActive(true);
  try {
    await context.saveNow();
    const selections = completion.eraseOriginal
      ? await resolveTranslationInpaintingSelections(options.selection)
      : null;
    const outcome = await context.runPasses(chapter);
    if (outcome !== "completed" || !selections) return outcome;
    return await runTranslationInpaintingWorkflow({
      bubbleLayout: completion.bubbleLayout,
      clearPageImageCache: context.clearPageImageCache,
      clearRetouchHistory: context.clearRetouchHistory,
      currentChapter: chapter,
      mergeLiveChapter: context.mergeLiveChapter,
      notificationPort: context.notificationPort,
      recordImageEdit: context.recordImageEdit,
      refreshLibrary: context.refreshLibrary,
      selections,
      setShowBlockChrome: context.setShowBlockChrome,
      t: context.t,
    });
  } catch (error) {
    console.error(error);
    context.notificationPort.error(
      context.t(
        completion.eraseOriginal
          ? completion.bubbleLayout
            ? "translation.bubbleLayoutWorkflowFailed"
            : "translation.eraseOriginalWorkflowFailed"
          : "translation.errors.jobFailed",
      ),
    );
    return "failed";
  } finally {
    context.flowActiveRef.current = false;
    context.setFlowActive(false);
  }
}

export function resolveTranslationCompletionOptions(
  options: Pick<
    TranslationFlowOptions,
    "eraseOriginalWorkflow" | "bubbleLayoutWorkflow"
  >,
): { eraseOriginal: boolean; bubbleLayout: boolean } {
  const eraseOriginal =
    options.eraseOriginalWorkflow ?? options.bubbleLayoutWorkflow ?? false;
  return {
    eraseOriginal,
    bubbleLayout: eraseOriginal && (options.bubbleLayoutWorkflow ?? true),
  };
}

type TranslationInpaintingWorkflowOptions = {
  bubbleLayout: boolean;
  clearPageImageCache: () => void;
  clearRetouchHistory: () => void;
  currentChapter: ChapterSnapshot;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  notificationPort: NotificationPort;
  recordImageEdit: (entry: { label: string; transactionId: string }) => void;
  refreshLibrary: () => Promise<void>;
  selections: AutoInpaintingChapterSelection[];
  setShowBlockChrome: (visible: boolean) => void;
  t: TFunction<"renderer">;
};

type TranslationInpaintingResult = Awaited<
  ReturnType<typeof inpaintingGateway.startInpainting>
>;

export async function runTranslationInpaintingWorkflow(
  options: TranslationInpaintingWorkflowOptions,
): Promise<RunAnalysisOutcome> {
  if (options.selections.length === 0) {
    options.setShowBlockChrome(false);
    return "completed";
  }
  try {
    const result = await inpaintingGateway.startInpainting({
      mode: "selection-pattern",
      workId: options.currentChapter.workId,
      selections: options.selections,
      ...(options.bubbleLayout
        ? {
            postprocess: {
              bubbleLayout: {
                enabled: true as const,
                policy: "balanced" as const,
              },
            },
          }
        : {}),
    });
    return await finishTranslationInpainting(result, options);
  } catch (error) {
    console.error(error);
    options.notificationPort.error(
      options.t(
        options.bubbleLayout
          ? "translation.bubbleLayoutWorkflowFailed"
          : "translation.eraseOriginalWorkflowFailed",
      ),
    );
    return "failed";
  }
}

async function finishTranslationInpainting(
  result: TranslationInpaintingResult,
  options: TranslationInpaintingWorkflowOptions,
): Promise<RunAnalysisOutcome> {
  const liveChapter = result.chapters?.find(
    (chapter) => chapter.id === options.currentChapter.id,
  );
  if (liveChapter) {
    options.clearRetouchHistory();
    options.clearPageImageCache();
    options.mergeLiveChapter(liveChapter);
  }
  if (result.historyTransaction) {
    options.recordImageEdit({
      label: options.t("workspaceHistory.autoInpainting"),
      transactionId: result.historyTransaction.transactionId,
    });
  }
  if (result.status !== "completed") {
    if (result.status === "failed") {
      options.notificationPort.error(
        result.error ??
          options.t(
            options.bubbleLayout
              ? "translation.bubbleLayoutWorkflowFailed"
              : "translation.eraseOriginalWorkflowFailed",
          ),
      );
    }
    return result.status;
  }
  options.setShowBlockChrome(false);
  await refreshTranslationLibrary(options);
  options.notificationPort.success(
    options.t(
      options.bubbleLayout
        ? "translation.bubbleLayoutWorkflowCompleted"
        : "translation.eraseOriginalWorkflowCompleted",
    ),
  );
  return "completed";
}

async function refreshTranslationLibrary(
  options: TranslationInpaintingWorkflowOptions,
): Promise<void> {
  try {
    await options.refreshLibrary();
  } catch (error) {
    console.error(error);
    options.notificationPort.warn(options.t("translation.refreshWarning"));
  }
}
