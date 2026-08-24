import type { MangaPage } from "../../../shared/libraryTypes";
import {
  buildChapterSelectionRequests,
  resolveChapterTriState,
  resolveSelectedPageIds,
  toggleChapterSelection,
  togglePageSelection,
  type PageSelection,
  type PageSelectionMap,
  type TriState,
} from "./pageSelection";

export type { TriState };

/** A chapter and how much of it to translate in one flow run. */
export type ChapterRunSelection =
  | { chapterId: string; mode: "all" }
  | { chapterId: string; mode: "pending" }
  | { chapterId: string; mode: "page-set"; pageIds: string[] };

/**
 * Per-chapter selection state held by the translation options modal. Translation
 * is the only domain that offers the coarse `pending` ("untranslated only")
 * marker, so it uses the full selection union.
 */
export type ChapterSel = PageSelection;

export type ChapterSelectionMap = PageSelectionMap<ChapterSel>;

export type TranslationOptionsInitialScope = "current-pending" | "work-all";

const SELECT_ALL: ChapterSel = { kind: "all" };

/** The set of page ids that should render as checked for a chapter. */
export function selectedPageIds(
  sel: ChapterSel | undefined,
  pages: MangaPage[],
): Set<string> {
  return resolveSelectedPageIds(sel, pages);
}

/** Tri-state for a chapter's own checkbox. Uses loaded pages when available. */
export function chapterTriState(
  sel: ChapterSel | undefined,
  pageCount: number,
  loadedPages?: MangaPage[],
): TriState {
  return resolveChapterTriState(sel, pageCount, loadedPages);
}

/** Toggle a whole chapter on/off (its checkbox click). */
export function toggleChapter(
  map: ChapterSelectionMap,
  chapterId: string,
): ChapterSelectionMap {
  return toggleChapterSelection(map, chapterId, SELECT_ALL);
}

/** Toggle a single page, seeding an explicit set from what is currently checked. */
export function togglePage(
  map: ChapterSelectionMap,
  chapterId: string,
  pageId: string,
  pages: MangaPage[],
): ChapterSelectionMap {
  return togglePageSelection(map, chapterId, pageId, pages, {
    selectAll: SELECT_ALL,
  });
}

/** Build the flow run selection in the given (library) chapter order. */
export function buildRunSelection(
  chapterOrder: string[],
  map: ChapterSelectionMap,
): ChapterRunSelection[] {
  return buildChapterSelectionRequests<ChapterSel, "all" | "pending">(
    chapterOrder,
    map,
    (selection) => (selection.kind === "all" ? "all" : "pending"),
  );
}
