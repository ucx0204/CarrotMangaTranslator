import type { MangaPage } from "../../../shared/libraryTypes";
import type { PageImageExportChapterSelection } from "../../../shared/pageImageExportTypes";
import {
  buildChapterSelectionRequests,
  resolveChapterTriState,
  resolveSelectedPageIds,
  toggleChapterSelection,
  togglePageSelection,
  type PageSelectionMap,
  type TriState,
} from "./pageSelection";

/** A chapter and the final images selected for one export request. */
export type ExportChapterSelection = PageImageExportChapterSelection;

/**
 * Export has no "untranslated only" notion, so it uses the narrower selection
 * state: a whole chapter, or an explicit page set.
 */
export type ExportChapterSelectionState =
  | { kind: "all" }
  | { kind: "pages"; pageIds: Set<string> };

/** Per-chapter state owned by the export options modal. */
export type ExportSelectionMap = PageSelectionMap<ExportChapterSelectionState>;

const SELECT_ALL: ExportChapterSelectionState = { kind: "all" };

export function createDefaultExportSelection(
  chapterId: string,
  currentPageId: string,
): ExportSelectionMap {
  return new Map([
    [chapterId, { kind: "pages", pageIds: new Set([currentPageId]) }],
  ]);
}

export function selectedExportPageIds(
  selection: ExportChapterSelectionState | undefined,
  pages: MangaPage[],
): Set<string> {
  return resolveSelectedPageIds(selection, pages);
}

export function exportChapterTriState(
  selection: ExportChapterSelectionState | undefined,
  pageCount: number,
  loadedPages?: MangaPage[],
): TriState {
  return resolveChapterTriState(selection, pageCount, loadedPages);
}

export function toggleExportChapter(
  selection: ExportSelectionMap,
  chapterId: string,
): ExportSelectionMap {
  return toggleChapterSelection(selection, chapterId, SELECT_ALL);
}

export function toggleExportPage(
  selection: ExportSelectionMap,
  chapterId: string,
  pageId: string,
  pages: MangaPage[],
): ExportSelectionMap {
  // Ticking every page of a chapter means "the whole chapter", so it collapses
  // back to `all` and stays correct if pages are added later.
  return togglePageSelection(selection, chapterId, pageId, pages, {
    collapseFullPageSetToAll: true,
    selectAll: SELECT_ALL,
  });
}

/** Builds the public request selection in library chapter order. */
export function buildExportSelection(
  chapterOrder: string[],
  selection: ExportSelectionMap,
): ExportChapterSelection[] {
  return buildChapterSelectionRequests<ExportChapterSelectionState, "all">(
    chapterOrder,
    selection,
    () => "all",
  );
}
