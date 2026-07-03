import type { MangaPage } from "../../../shared/libraryTypes";

/** A chapter and how much of it to translate in one flow run. */
export type ChapterRunSelection =
  | { chapterId: string; mode: "all" }
  | { chapterId: string; mode: "pending" }
  | { chapterId: string; mode: "page-set"; pageIds: string[] };

/**
 * Per-chapter selection state held by the translation options modal.
 * - `all` / `pending` are coarse markers that need no page loading and reuse
 *   the existing `all` / `pending` run modes.
 * - `pages` is an explicit subset the user built by ticking individual pages;
 *   it runs through the new `page-set` mode.
 * A chapter absent from the map is not selected.
 */
export type ChapterSel =
  | { kind: "all" }
  | { kind: "pending" }
  | { kind: "pages"; pageIds: Set<string> };

export type ChapterSelectionMap = Map<string, ChapterSel>;

export type TriState = "none" | "some" | "all";

function pendingIds(pages: MangaPage[]): string[] {
  return pages
    .filter((page) => page.analysisStatus !== "completed")
    .map((page) => page.id);
}

/** The set of page ids that should render as checked for a chapter. */
export function selectedPageIds(
  sel: ChapterSel | undefined,
  pages: MangaPage[],
): Set<string> {
  if (!sel) {
    return new Set();
  }
  if (sel.kind === "all") {
    return new Set(pages.map((page) => page.id));
  }
  if (sel.kind === "pending") {
    return new Set(pendingIds(pages));
  }
  return new Set(sel.pageIds);
}

/** Tri-state for a chapter's own checkbox. Uses loaded pages when available. */
export function chapterTriState(
  sel: ChapterSel | undefined,
  pageCount: number,
  loadedPages?: MangaPage[],
): TriState {
  if (!sel) {
    return "none";
  }
  if (sel.kind === "all") {
    return "all";
  }
  if (sel.kind === "pending") {
    if (!loadedPages) {
      return "some";
    }
    const pending = pendingIds(loadedPages).length;
    if (pending === 0) {
      return "none";
    }
    return pending === loadedPages.length ? "all" : "some";
  }
  const count = sel.pageIds.size;
  if (count === 0) {
    return "none";
  }
  const total = loadedPages ? loadedPages.length : pageCount;
  return count >= total ? "all" : "some";
}

/** Toggle a whole chapter on/off (its checkbox click). */
export function toggleChapter(
  map: ChapterSelectionMap,
  chapterId: string,
): ChapterSelectionMap {
  const next = new Map(map);
  if (next.has(chapterId)) {
    next.delete(chapterId);
  } else {
    next.set(chapterId, { kind: "all" });
  }
  return next;
}

/**
 * Toggle a single page. Seeds an explicit `pages` set from whatever is currently
 * shown as checked (so touching one page in an `all`/`pending` chapter keeps the
 * rest), then flips the given page. Empty result deselects the chapter.
 */
export function togglePage(
  map: ChapterSelectionMap,
  chapterId: string,
  pageId: string,
  pages: MangaPage[],
): ChapterSelectionMap {
  const seed = selectedPageIds(map.get(chapterId), pages);
  if (seed.has(pageId)) {
    seed.delete(pageId);
  } else {
    seed.add(pageId);
  }
  const next = new Map(map);
  if (seed.size === 0) {
    next.delete(chapterId);
  } else {
    next.set(chapterId, { kind: "pages", pageIds: seed });
  }
  return next;
}

/**
 * Maps a 1st-pass selection to its 2nd-pass equivalent. An explicit page subset
 * is re-translated exactly; whole-chapter / pending selections re-translate the
 * whole chapter (context improved for every page — matches the guidance that a
 * 2nd pass re-runs all pages).
 */
export function toSecondPassSelection(
  selection: ChapterRunSelection,
): ChapterRunSelection {
  return selection.mode === "page-set"
    ? selection
    : { chapterId: selection.chapterId, mode: "all" };
}

/** Build the flow run selection in the given (library) chapter order. */
export function buildRunSelection(
  chapterOrder: string[],
  map: ChapterSelectionMap,
): ChapterRunSelection[] {
  const result: ChapterRunSelection[] = [];
  for (const chapterId of chapterOrder) {
    const sel = map.get(chapterId);
    if (!sel) {
      continue;
    }
    if (sel.kind === "all") {
      result.push({ chapterId, mode: "all" });
    } else if (sel.kind === "pending") {
      result.push({ chapterId, mode: "pending" });
    } else if (sel.pageIds.size > 0) {
      result.push({ chapterId, mode: "page-set", pageIds: [...sel.pageIds] });
    }
  }
  return result;
}
