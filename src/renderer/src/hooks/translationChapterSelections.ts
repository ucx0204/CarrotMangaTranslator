import type { AutoInpaintingChapterSelection } from "../../../shared/inpaintingTypes";
import { libraryGateway } from "../api/libraryGateway";
import type { ChapterRunSelection } from "../lib/translationSelection";
import type { TranslationFlowOptions } from "./translationActionTypes";

export type ResolvedChapterSelections = {
  analysis: ChapterRunSelection;
  inpainting: AutoInpaintingChapterSelection | null;
};

export async function resolveTranslationChapterSelections(
  selection: ChapterRunSelection,
  workflowMode: TranslationFlowOptions["workflowMode"],
  completion: { eraseOriginal: boolean; bubbleLayout: boolean },
): Promise<ResolvedChapterSelections> {
  if (!completion.eraseOriginal) {
    return { analysis: selection, inpainting: null };
  }
  if (selection.mode === "all" || selection.mode === "page-set") {
    return { analysis: selection, inpainting: selection };
  }
  if (workflowMode === "two-pass") {
    // Pass 2 expands pending to the whole chapter, so the downstream stage
    // must cover that same effective range.
    return {
      analysis: selection,
      inpainting: { chapterId: selection.chapterId, mode: "all" },
    };
  }

  const chapter = await libraryGateway.openChapter(selection.chapterId);
  const workflow = completion.bubbleLayout ? "bubble-layout" : "erase-original";
  const inpaintingPageIds = chapter.pages
    .filter(
      (page) =>
        page.analysisStatus !== "completed" ||
        page.translationCompletion === undefined ||
        page.translationCompletion.workflow !== workflow ||
        page.translationCompletion.status !== "completed",
    )
    .map((page) => page.id);
  const analysisPageIds = chapter.pages
    .filter(
      (page) =>
        page.analysisStatus !== "completed" ||
        page.translationCompletion === undefined ||
        page.translationCompletion.workflow !== workflow,
    )
    .map((page) => page.id);
  return {
    analysis: createPageSetSelection(selection, analysisPageIds) ?? selection,
    inpainting: createPageSetSelection(selection, inpaintingPageIds),
  };
}

function createPageSetSelection(
  selection: Pick<ChapterRunSelection, "chapterId">,
  pageIds: string[],
): Extract<ChapterRunSelection, { mode: "page-set" }> | null {
  return pageIds.length > 0
    ? { chapterId: selection.chapterId, mode: "page-set", pageIds }
    : null;
}
