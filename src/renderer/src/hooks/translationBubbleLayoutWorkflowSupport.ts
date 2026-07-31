import type { TFunction } from "i18next";
import type {
  AutoInpaintingChapterSelection,
  StartInpaintingResult,
} from "../../../shared/inpaintingTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { TranslationFlowOptions } from "./translationActionTypes";

type InpaintingResultContext = {
  clearRetouchHistory: () => void;
  clearPageImageCache: () => void;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  recordImageEdit: (entry: {
    label: string;
    transactionId: string;
    chapterId?: string;
  }) => void;
  t: TFunction<"renderer">;
};

export function applyTranslationInpaintingResult(
  result: StartInpaintingResult,
  selection: AutoInpaintingChapterSelection,
  currentChapter: ChapterSnapshot,
  context: InpaintingResultContext,
): void {
  const liveChapter = result.chapters?.find(
    (chapter) => chapter.id === currentChapter.id,
  );
  if (liveChapter) {
    context.clearRetouchHistory();
    context.clearPageImageCache();
    context.mergeLiveChapter(liveChapter);
  }
  if (result.historyTransaction) {
    context.recordImageEdit({
      label: context.t("workspaceHistory.autoInpainting"),
      transactionId: result.historyTransaction.transactionId,
      chapterId: selection.chapterId,
    });
  }
}

export async function refreshTranslationLibrary(context: {
  notificationPort: { warn: (message: string) => void };
  refreshLibrary: () => Promise<void>;
  t: TFunction<"renderer">;
}): Promise<void> {
  try {
    await context.refreshLibrary();
  } catch (error) {
    console.error(error);
    context.notificationPort.warn(context.t("translation.refreshWarning"));
  }
}

export function resolveNaturalTextLayout(
  requested: boolean | undefined,
  savedDefault: boolean | undefined,
): boolean {
  if (requested !== undefined) return requested;
  return savedDefault ?? true;
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
