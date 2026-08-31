import type { AutoInpaintingChapterSelection } from "../../../shared/inpaintingTypes";
import { libraryGateway } from "../api/libraryGateway";
import type { ChapterRunSelection } from "../lib/translationSelection";

export type ResolvedChapterSelections = {
  analysis: ChapterRunSelection | null;
  inpainting: AutoInpaintingChapterSelection | null;
};

export async function resolveTranslationChapterSelections(
  selection: ChapterRunSelection,
  completion: { eraseOriginal: boolean; bubbleLayout: boolean },
): Promise<ResolvedChapterSelections> {
  if (!completion.eraseOriginal) {
    return { analysis: selection, inpainting: null };
  }
  if (selection.mode === "all") {
    return { analysis: selection, inpainting: selection };
  }
  const chapter = await libraryGateway.openChapter(selection.chapterId);
  const workflow = completion.bubbleLayout ? "bubble-layout" : "erase-original";
  if (selection.mode === "page-set") {
    const selectedIds = new Set(selection.pageIds);
    const restartIds = new Set(selection.restartPageIds);
    const analysisPageIds = chapter.pages
      .filter(
        (page) =>
          selectedIds.has(page.id) &&
          (restartIds.has(page.id) ||
            page.analysisStatus !== "completed" ||
            page.translationCompletion?.workflow !== workflow),
      )
      .map((page) => page.id);
    return {
      analysis: createPageSetSelection(
        selection,
        analysisPageIds,
        analysisPageIds.filter((pageId) => restartIds.has(pageId)),
      ),
      inpainting: {
        chapterId: selection.chapterId,
        mode: "page-set",
        pageIds: selection.pageIds,
      },
    };
  }
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
    analysis: createPageSetSelection(selection, analysisPageIds),
    inpainting: createInpaintingPageSetSelection(selection, inpaintingPageIds),
  };
}

function createPageSetSelection(
  selection: Pick<ChapterRunSelection, "chapterId">,
  pageIds: string[],
  restartPageIds: string[] = pageIds,
): Extract<ChapterRunSelection, { mode: "page-set" }> | null {
  return pageIds.length > 0
    ? {
        chapterId: selection.chapterId,
        mode: "page-set",
        pageIds,
        restartPageIds,
      }
    : null;
}

function createInpaintingPageSetSelection(
  selection: Pick<ChapterRunSelection, "chapterId">,
  pageIds: string[],
): Extract<AutoInpaintingChapterSelection, { mode: "page-set" }> | null {
  return pageIds.length > 0
    ? {
        chapterId: selection.chapterId,
        mode: "page-set",
        pageIds,
      }
    : null;
}
