import type { MangaPage } from "../../../shared/libraryTypes";

/**
 * Shared chapter/page selection core.
 *
 * Translation and export both let the user tick chapters and individual pages;
 * translation additionally offers a coarse "untranslated only" marker. These
 * primitives own the tri-state maths and the toggle rules so the two domains
 * cannot drift apart, and each domain keeps only its own request-building.
 */

export type TriState = "none" | "some" | "all";

/**
 * Per-chapter selection state.
 * - `all` / `pending` are coarse markers that need no page loading.
 * - `pages` is an explicit subset the user built by ticking individual pages.
 * A chapter absent from the map is not selected.
 */
export type PageSelection =
  | { kind: "all" }
  | { kind: "pending" }
  | { kind: "pages"; pageIds: Set<string> };

export type PageSelectionMap<TSelection extends PageSelection> = Map<
  string,
  TSelection
>;

function pendingPageIds(pages: MangaPage[]): string[] {
  return pages
    .filter((page) => page.analysisStatus !== "completed")
    .map((page) => page.id);
}

/** The set of page ids that should render as checked for a chapter. */
export function resolveSelectedPageIds(
  selection: PageSelection | undefined,
  pages: MangaPage[],
): Set<string> {
  if (!selection) return new Set();
  if (selection.kind === "all") return new Set(pages.map((page) => page.id));
  if (selection.kind === "pending") return new Set(pendingPageIds(pages));
  return new Set(selection.pageIds);
}

/** Tri-state for a chapter's own checkbox. Uses loaded pages when available. */
export function resolveChapterTriState(
  selection: PageSelection | undefined,
  pageCount: number,
  loadedPages?: MangaPage[],
): TriState {
  if (!selection) return "none";
  if (selection.kind === "all") return "all";
  if (selection.kind === "pending") {
    return resolvePendingTriState(loadedPages);
  }
  const count = selection.pageIds.size;
  if (count === 0) return "none";
  const total = loadedPages ? loadedPages.length : pageCount;
  return count >= total && total > 0 ? "all" : "some";
}

function resolvePendingTriState(
  loadedPages: MangaPage[] | undefined,
): TriState {
  if (!loadedPages) return "some";
  const pending = pendingPageIds(loadedPages).length;
  if (pending === 0) return "none";
  return pending === loadedPages.length ? "all" : "some";
}

/**
 * Toggle a whole chapter from its checkbox.
 *
 * Follows the standard tri-state contract: a partially selected chapter becomes
 * fully selected, and only a fully selected chapter clears.
 */
export function toggleChapterSelection<TSelection extends PageSelection>(
  map: PageSelectionMap<TSelection>,
  chapterId: string,
  selectAll: TSelection,
): PageSelectionMap<TSelection> {
  const next = new Map(map);
  if (next.get(chapterId)?.kind === "all") {
    next.delete(chapterId);
  } else {
    next.set(chapterId, selectAll);
  }
  return next;
}

/**
 * Toggle a single page. Seeds an explicit page set from whatever currently
 * renders as checked, so touching one page in an `all`/`pending` chapter keeps
 * the rest, then flips the given page. An empty result deselects the chapter.
 */
export function togglePageSelection<TSelection extends PageSelection>(
  map: PageSelectionMap<TSelection>,
  chapterId: string,
  pageId: string,
  pages: MangaPage[],
  {
    collapseFullPageSetToAll = false,
    selectAll,
  }: {
    /** Export collapses a fully ticked chapter back to `all`; translation keeps the explicit set. */
    collapseFullPageSetToAll?: boolean;
    selectAll: TSelection;
  },
): PageSelectionMap<TSelection> {
  const seed = resolveSelectedPageIds(map.get(chapterId), pages);
  if (seed.has(pageId)) {
    seed.delete(pageId);
  } else {
    seed.add(pageId);
  }

  const next = new Map(map);
  if (seed.size === 0) {
    next.delete(chapterId);
    return next;
  }
  if (
    collapseFullPageSetToAll &&
    pages.length > 0 &&
    seed.size === pages.length
  ) {
    next.set(chapterId, selectAll);
    return next;
  }
  next.set(chapterId, {
    kind: "pages",
    pageIds: orderPageIds(seed, pages),
  } as TSelection);
  return next;
}

/** Keeps explicit page sets in page order so requests are reproducible. */
function orderPageIds(selected: Set<string>, pages: MangaPage[]): Set<string> {
  return new Set(
    pages.filter((page) => selected.has(page.id)).map((page) => page.id),
  );
}

/** Request mode for one chapter, in the shape both job contracts accept. */
export type ChapterSelectionRequest<TMode extends string> =
  | { chapterId: string; mode: TMode }
  | { chapterId: string; mode: "page-set"; pageIds: string[] };

/**
 * Builds request entries in the given (library) chapter order, dropping empty
 * page sets so a request never asks for zero pages.
 */
export function buildChapterSelectionRequests<
  TSelection extends PageSelection,
  TMode extends string,
>(
  chapterOrder: string[],
  map: PageSelectionMap<TSelection>,
  resolveMode: (selection: TSelection) => TMode | null,
): ChapterSelectionRequest<TMode>[] {
  const result: ChapterSelectionRequest<TMode>[] = [];
  for (const chapterId of chapterOrder) {
    const selection = map.get(chapterId);
    if (!selection) continue;
    if (selection.kind === "pages") {
      if (selection.pageIds.size > 0) {
        result.push({
          chapterId,
          mode: "page-set",
          pageIds: [...selection.pageIds],
        });
      }
      continue;
    }
    const mode = resolveMode(selection);
    if (mode) result.push({ chapterId, mode });
  }
  return result;
}
