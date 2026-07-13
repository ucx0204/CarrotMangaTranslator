import type { MangaPage } from "../../../shared/libraryTypes";
import type { PageImageExportChapterSelection } from "../../../shared/pageImageExportTypes";
import type { TriState } from "./translationSelection";

/** A chapter and the final images selected for one export request. */
export type ExportChapterSelection = PageImageExportChapterSelection;

export type ExportChapterSelectionState =
  | { kind: "all" }
  | { kind: "pages"; pageIds: Set<string> };

/** Per-chapter state owned by the export options modal. */
export type ExportSelectionMap = Map<string, ExportChapterSelectionState>;

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
  if (!selection) {
    return new Set();
  }
  if (selection.kind === "all") {
    return new Set(pages.map((page) => page.id));
  }
  return new Set(selection.pageIds);
}

export function exportChapterTriState(
  selection: ExportChapterSelectionState | undefined,
  pageCount: number,
  loadedPages?: MangaPage[],
): TriState {
  if (!selection) {
    return "none";
  }
  if (selection.kind === "all") {
    return "all";
  }
  const selectedCount = selection.pageIds.size;
  if (selectedCount === 0) {
    return "none";
  }
  const total = loadedPages?.length ?? pageCount;
  return selectedCount >= total && total > 0 ? "all" : "some";
}

export function toggleExportChapter(
  selection: ExportSelectionMap,
  chapterId: string,
): ExportSelectionMap {
  const next = new Map(selection);
  if (next.get(chapterId)?.kind === "all") {
    next.delete(chapterId);
  } else {
    next.set(chapterId, { kind: "all" });
  }
  return next;
}

export function toggleExportPage(
  selection: ExportSelectionMap,
  chapterId: string,
  pageId: string,
  pages: MangaPage[],
): ExportSelectionMap {
  const selected = selectedExportPageIds(selection.get(chapterId), pages);
  if (selected.has(pageId)) {
    selected.delete(pageId);
  } else {
    selected.add(pageId);
  }

  const next = new Map(selection);
  if (selected.size === 0) {
    next.delete(chapterId);
    return next;
  }
  if (selected.size === pages.length && pages.length > 0) {
    next.set(chapterId, { kind: "all" });
    return next;
  }
  const orderedIds = pages
    .filter((page) => selected.has(page.id))
    .map((page) => page.id);
  next.set(chapterId, { kind: "pages", pageIds: new Set(orderedIds) });
  return next;
}

/** Builds the public request selection in library chapter order. */
export function buildExportSelection(
  chapterOrder: string[],
  selection: ExportSelectionMap,
): ExportChapterSelection[] {
  const result: ExportChapterSelection[] = [];
  for (const chapterId of chapterOrder) {
    const chapterSelection = selection.get(chapterId);
    if (!chapterSelection) {
      continue;
    }
    if (chapterSelection.kind === "all") {
      result.push({ chapterId, mode: "all" });
    } else if (chapterSelection.pageIds.size > 0) {
      result.push({
        chapterId,
        mode: "page-set",
        pageIds: [...chapterSelection.pageIds],
      });
    }
  }
  return result;
}
