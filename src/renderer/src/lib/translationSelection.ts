import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type {
  MangaPage,
  TranslationCompletionWorkflow,
} from "../../../shared/libraryTypes";
import type { TriState } from "./pageSelection";
import { createPageRevision } from "../../../shared/pageRevision";
import {
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
} from "../../../shared/translationLanguageDefaults";

export type { TriState };

export type PageRunIntent = "none" | "restart" | "resume";

export type TranslationResumeContext = Readonly<{
  blockMode: AnalysisBlockMode;
  sourceLanguage: string;
  targetLanguage: string;
  completionWorkflow?: TranslationCompletionWorkflow;
}>;

/** A chapter and the page-level model restart intent for one flow run. */
export type ChapterRunSelection =
  | { chapterId: string; mode: "all" }
  | { chapterId: string; mode: "pending" }
  | {
      chapterId: string;
      mode: "page-set";
      pageIds: string[];
      restartPageIds: string[];
    };

export type ChapterSel =
  | { kind: "all" }
  | { kind: "pending" }
  | {
      kind: "pages";
      pageIds: Set<string>;
      restartPageIds?: Set<string>;
    };

export type ChapterSelectionMap = Map<string, ChapterSel>;
export type TranslationOptionsInitialScope = "current-pending" | "work-all";
const DEFAULT_RESUME_CONTEXT: TranslationResumeContext = {
  blockMode: "auto",
  sourceLanguage: DEFAULT_SOURCE_LANGUAGE,
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
};

export function createPendingChapterSelection(
  pages: MangaPage[],
  context: TranslationResumeContext,
): ChapterSel | undefined {
  const pageIds = new Set<string>();
  const restartPageIds = new Set<string>();
  for (const page of pages) {
    const intent = defaultPendingIntent(page, context);
    if (intent === "none") continue;
    pageIds.add(page.id);
    if (intent === "restart") restartPageIds.add(page.id);
  }
  return pageIds.size > 0
    ? { kind: "pages", pageIds, restartPageIds }
    : undefined;
}

export function selectedPageIds(
  selection: ChapterSel | undefined,
  pages: MangaPage[],
  context: TranslationResumeContext = DEFAULT_RESUME_CONTEXT,
): Set<string> {
  if (!selection) return new Set();
  if (selection.kind === "all") return new Set(pages.map((page) => page.id));
  if (selection.kind === "pending") {
    return new Set(
      pages
        .filter((page) => defaultPendingIntent(page, context) !== "none")
        .map((page) => page.id),
    );
  }
  return new Set(selection.pageIds);
}

export function pageRunIntent(
  selection: ChapterSel | undefined,
  page: MangaPage,
  context: TranslationResumeContext = DEFAULT_RESUME_CONTEXT,
): PageRunIntent {
  if (!selection) return "none";
  if (selection.kind === "all") return "restart";
  if (selection.kind === "pending") return defaultPendingIntent(page, context);
  if (!selection.pageIds.has(page.id)) return "none";
  if (selection.restartPageIds?.has(page.id)) return "restart";
  return canResumePage(page, context) ? "resume" : "restart";
}

export function chapterTriState(
  selection: ChapterSel | undefined,
  pageCount: number,
  loadedPages?: MangaPage[],
  context: TranslationResumeContext = DEFAULT_RESUME_CONTEXT,
): TriState {
  if (!selection) return "none";
  if (selection.kind === "all") return "all";
  if (!loadedPages) return "some";
  const count = selectedPageIds(selection, loadedPages, context).size;
  if (count === 0) return "none";
  return count >= Math.max(pageCount, loadedPages.length) ? "all" : "some";
}

export function toggleChapter(
  map: ChapterSelectionMap,
  chapterId: string,
): ChapterSelectionMap {
  const next = new Map(map);
  if (next.get(chapterId)?.kind === "all") next.delete(chapterId);
  else next.set(chapterId, { kind: "all" });
  return next;
}

/** Partial pages cycle resume -> restart -> excluded -> resume. */
export function togglePage(
  map: ChapterSelectionMap,
  chapterId: string,
  pageId: string,
  pages: MangaPage[],
  context: TranslationResumeContext = DEFAULT_RESUME_CONTEXT,
): ChapterSelectionMap {
  const currentSelection = map.get(chapterId);
  const pageIds = selectedPageIds(currentSelection, pages, context);
  const restartPageIds = new Set(
    pages
      .filter(
        (page) => pageRunIntent(currentSelection, page, context) === "restart",
      )
      .map((page) => page.id),
  );
  const page = pages.find((candidate) => candidate.id === pageId);
  if (!page) return map;
  const currentIntent = pageRunIntent(currentSelection, page, context);
  if (currentIntent === "resume") {
    pageIds.add(pageId);
    restartPageIds.add(pageId);
  } else if (currentIntent === "restart") {
    pageIds.delete(pageId);
    restartPageIds.delete(pageId);
  } else {
    pageIds.add(pageId);
    if (canResumePage(page, context)) restartPageIds.delete(pageId);
    else restartPageIds.add(pageId);
  }
  return replaceExplicitSelection(
    map,
    chapterId,
    pages,
    pageIds,
    restartPageIds,
  );
}

/** Applies the anchor page's current run intent to an inclusive page range. */
export function applyPageRangeFromAnchor(
  map: ChapterSelectionMap,
  chapterId: string,
  anchorPageId: string,
  targetPageId: string,
  pages: MangaPage[],
  context: TranslationResumeContext = DEFAULT_RESUME_CONTEXT,
): ChapterSelectionMap {
  const anchorPage = pages.find((page) => page.id === anchorPageId);
  const targetIndex = pages.findIndex((page) => page.id === targetPageId);
  if (!anchorPage || targetIndex < 0) return map;

  const currentSelection = map.get(chapterId);
  const anchorIndex = pages.indexOf(anchorPage);
  const intent = pageRunIntent(currentSelection, anchorPage, context);
  const pageIds = selectedPageIds(currentSelection, pages, context);
  const restartPageIds = new Set(
    pages
      .filter(
        (page) => pageRunIntent(currentSelection, page, context) === "restart",
      )
      .map((page) => page.id),
  );
  const firstIndex = Math.min(anchorIndex, targetIndex);
  const lastIndex = Math.max(anchorIndex, targetIndex);

  for (const page of pages.slice(firstIndex, lastIndex + 1)) {
    if (intent === "none") {
      pageIds.delete(page.id);
      restartPageIds.delete(page.id);
      continue;
    }
    pageIds.add(page.id);
    if (intent === "restart" || !canResumePage(page, context)) {
      restartPageIds.add(page.id);
    } else {
      restartPageIds.delete(page.id);
    }
  }

  return replaceExplicitSelection(
    map,
    chapterId,
    pages,
    pageIds,
    restartPageIds,
  );
}

export function buildRunSelection(
  chapterOrder: string[],
  map: ChapterSelectionMap,
): ChapterRunSelection[] {
  const result: ChapterRunSelection[] = [];
  for (const chapterId of chapterOrder) {
    const selection = map.get(chapterId);
    if (!selection) continue;
    if (selection.kind === "all") {
      result.push({ chapterId, mode: "all" });
      continue;
    }
    if (selection.kind === "pending") {
      result.push({ chapterId, mode: "pending" });
      continue;
    }
    if (selection.pageIds.size === 0) continue;
    result.push({
      chapterId,
      mode: "page-set",
      pageIds: [...selection.pageIds],
      restartPageIds: [
        ...(selection.restartPageIds ?? selection.pageIds),
      ].filter((pageId) => selection.pageIds.has(pageId)),
    });
  }
  return result;
}

function canResumePage(
  page: MangaPage,
  context: TranslationResumeContext,
): boolean {
  const checkpoint = page.translationCheckpoint;
  if (
    checkpoint &&
    checkpoint.blockMode === context.blockMode &&
    checkpoint.inputRevision === createPageRevision(page) &&
    checkpoint.sourceLanguage === context.sourceLanguage &&
    checkpoint.targetLanguage === context.targetLanguage
  ) {
    return true;
  }
  const completion = page.translationCompletion;
  return Boolean(
    context.completionWorkflow &&
    page.analysisStatus === "completed" &&
    completion?.workflow === context.completionWorkflow &&
    completion.status !== "completed",
  );
}

function defaultPendingIntent(
  page: MangaPage,
  context: TranslationResumeContext,
): PageRunIntent {
  if (canResumePage(page, context)) return "resume";
  return page.analysisStatus === "completed" ? "none" : "restart";
}

function replaceExplicitSelection(
  map: ChapterSelectionMap,
  chapterId: string,
  pages: MangaPage[],
  pageIds: Set<string>,
  restartPageIds: Set<string>,
): ChapterSelectionMap {
  const next = new Map(map);
  if (pageIds.size === 0) {
    next.delete(chapterId);
    return next;
  }
  const orderedPageIds = pages
    .filter((page) => pageIds.has(page.id))
    .map((page) => page.id);
  next.set(chapterId, {
    kind: "pages",
    pageIds: new Set(orderedPageIds),
    restartPageIds: new Set(
      orderedPageIds.filter((pageId) => restartPageIds.has(pageId)),
    ),
  });
  return next;
}
