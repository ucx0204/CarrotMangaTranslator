import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryChapterSummary,
  LibraryWorkSummary,
  MangaPage,
} from "../../../shared/libraryTypes";
import {
  applyPageRangeFromAnchor,
  chapterTriState,
  createPendingChapterSelection,
  pageRunIntent,
  selectedPageIds,
  toggleChapter,
  togglePage,
  type ChapterSel,
  type ChapterSelectionMap,
  type TranslationResumeContext,
} from "../lib/translationSelection";
import { Button } from "./ui/Button";
import { WorkPagePicker, type ChapterPagesLookup } from "./WorkPagePicker";

type ChapterPagePickerProps = {
  work: LibraryWorkSummary;
  currentChapter: ChapterSnapshot;
  currentPageId?: string | null;
  selection: ChapterSelectionMap;
  onChange: (next: ChapterSelectionMap) => void;
  resumeContext: TranslationResumeContext;
};

export function ChapterPagePicker(
  props: ChapterPagePickerProps,
): React.JSX.Element {
  const { work, currentChapter, currentPageId, selection, resumeContext } =
    props;
  const { t } = useTranslation("components");
  const actions = useChapterPagePickerActions(props);

  return (
    <WorkPagePicker
      work={work}
      currentChapter={currentChapter}
      currentPageId={currentPageId}
      header={
        <ChapterPickerHeader
          workTitle={work.title}
          onSelectAll={actions.selectAll}
          onSelectPending={actions.selectPending}
          onClear={actions.clear}
        />
      }
      getChapterTriState={(chapter, pages) =>
        chapterTriState(
          selection.get(chapter.id),
          chapter.pageCount,
          pages,
          resumeContext,
        )
      }
      getSelectedPageIds={(chapter, pages) =>
        selectedPageIds(selection.get(chapter.id), pages, resumeContext)
      }
      getPageSelectionState={(chapter, page) =>
        pageRunIntent(selection.get(chapter.id), page, resumeContext)
      }
      getPageSelectionTooltip={(chapter, page) =>
        resolveResumeTooltip(
          pageRunIntent(selection.get(chapter.id), page, resumeContext),
          page,
          t,
        )
      }
      getChapterSummary={(chapter, pages) =>
        resolveChapterSummary(chapter, pages, resumeContext, t)
      }
      renderSelectionSummary={(getPages) =>
        summarizeSelection(work, selection, getPages, resumeContext, t)
      }
      onToggleChapter={actions.toggleChapter}
      onTogglePage={actions.togglePage}
      onTogglePageRange={actions.togglePageRange}
    />
  );
}

function useChapterPagePickerActions({
  work,
  currentChapter,
  selection,
  onChange,
  resumeContext,
}: ChapterPagePickerProps) {
  const rangeAnchorRef = React.useRef<{
    chapterId: string;
    pageId: string;
  } | null>(null);
  React.useEffect(() => {
    rangeAnchorRef.current = null;
  }, [
    resumeContext.blockMode,
    resumeContext.completionWorkflow,
    resumeContext.sourceLanguage,
    resumeContext.targetLanguage,
  ]);
  const resetAnchor = (): void => {
    rangeAnchorRef.current = null;
  };
  const replaceEveryChapter = (
    make: (chapter: LibraryChapterSummary) => ChapterSel | undefined,
  ): void => {
    resetAnchor();
    onChange(createWorkSelection(work, make));
  };
  const toggleSinglePage = (
    chapterId: string,
    pageId: string,
    pages: MangaPage[],
  ): void => {
    rangeAnchorRef.current = { chapterId, pageId };
    onChange(togglePage(selection, chapterId, pageId, pages, resumeContext));
  };
  const togglePageRange = (
    chapterId: string,
    pageId: string,
    pages: MangaPage[],
  ): void => {
    const anchor = rangeAnchorRef.current;
    if (!anchor || anchor.chapterId !== chapterId) {
      toggleSinglePage(chapterId, pageId, pages);
      return;
    }
    onChange(
      applyPageRangeFromAnchor(
        selection,
        chapterId,
        anchor.pageId,
        pageId,
        pages,
        resumeContext,
      ),
    );
  };
  return {
    clear: () => {
      resetAnchor();
      onChange(new Map());
    },
    selectAll: () => replaceEveryChapter(() => ({ kind: "all" })),
    selectPending: () =>
      replaceEveryChapter((chapter) =>
        chapter.id === currentChapter.id
          ? createPendingChapterSelection(currentChapter.pages, resumeContext)
          : chapter.status === "completed"
            ? undefined
            : { kind: "pending" },
      ),
    toggleChapter: (chapterId: string) =>
      onChange(toggleChapter(selection, chapterId)),
    togglePage: toggleSinglePage,
    togglePageRange,
  };
}

function createWorkSelection(
  work: LibraryWorkSummary,
  make: (chapter: LibraryChapterSummary) => ChapterSel | undefined,
): ChapterSelectionMap {
  return new Map(
    work.chapters.flatMap((chapter) => {
      const next = make(chapter);
      return next ? [[chapter.id, next] as const] : [];
    }),
  );
}

function ChapterPickerHeader({
  workTitle,
  onSelectAll,
  onSelectPending,
  onClear,
}: {
  workTitle: string;
  onSelectAll: () => void;
  onSelectPending: () => void;
  onClear: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="translate-picker-head">
      <div className="translate-picker-heading">
        <div className="translate-picker-worktitle">{workTitle}</div>
        <div className="translate-picker-subtitle">
          {t("chapterPicker.prompt")}
        </div>
      </div>
      <div className="translate-picker-actions">
        <Button variant="ghost" size="sm" onClick={onSelectAll}>
          {t("common.selectAll")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onSelectPending}>
          {t("chapterPicker.untranslatedOnly")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear}>
          {t("common.clearAll")}
        </Button>
      </div>
    </div>
  );
}

function resolveChapterSummary(
  chapter: LibraryChapterSummary,
  pages: MangaPage[] | undefined,
  resumeContext: TranslationResumeContext,
  t: TFunction<"components">,
): string {
  if (pages) {
    const remaining = pages.filter(
      (page) =>
        pageRunIntent({ kind: "pending" }, page, resumeContext) !== "none",
    ).length;
    return remaining === 0
      ? t("chapterPicker.chapterSummaryComplete", { count: pages.length })
      : t("chapterPicker.chapterSummaryRemaining", {
          count: pages.length,
          remaining,
        });
  }
  const suffix =
    chapter.status === "completed"
      ? t("chapterPicker.statusSuffix.complete")
      : chapter.status === "partial"
        ? t("chapterPicker.statusSuffix.inProgress")
        : "";
  return t("chapterPicker.chapterSummary", {
    count: chapter.pageCount,
    suffix,
  });
}

function summarizeSelection(
  work: LibraryWorkSummary,
  selection: ChapterSelectionMap,
  getPages: ChapterPagesLookup,
  resumeContext: TranslationResumeContext,
  t: TFunction<"components">,
): string {
  const stats: SelectionSummaryStats = {
    resumeCount: 0,
    restartCount: 0,
    hasUnloadedSelection: false,
    loadedSelections: [],
  };
  for (const chapter of work.chapters) {
    const sel = selection.get(chapter.id);
    if (!sel) continue;
    const loaded = getPages(chapter.id);
    if (!loaded) {
      addUnloadedSelection(stats, chapter, sel);
      continue;
    }
    const intents = loaded.map((page) =>
      pageRunIntent(sel, page, resumeContext),
    );
    stats.loadedSelections.push({ pages: loaded, intents });
    stats.resumeCount += countIntent(intents, "resume");
    stats.restartCount += countIntent(intents, "restart");
  }
  return formatSelectionSummary(stats, t);
}

type SelectionSummaryStats = {
  resumeCount: number;
  restartCount: number;
  hasUnloadedSelection: boolean;
  loadedSelections: Array<{
    pages: MangaPage[];
    intents: Array<"none" | "restart" | "resume">;
  }>;
};

function addUnloadedSelection(
  stats: SelectionSummaryStats,
  chapter: LibraryChapterSummary,
  selection: ChapterSel,
): void {
  if (selection.kind === "pages") {
    const restartIds = selection.restartPageIds ?? selection.pageIds;
    stats.restartCount += restartIds.size;
    stats.resumeCount += selection.pageIds.size - restartIds.size;
    stats.hasUnloadedSelection ||= selection.pageIds.size > 0;
    return;
  }
  const selected =
    selection.kind === "all" || chapter.status !== "completed"
      ? chapter.pageCount
      : 0;
  stats.restartCount += selected;
  stats.hasUnloadedSelection ||= selected > 0;
}

function countIntent(
  intents: readonly ("none" | "restart" | "resume")[],
  target: "restart" | "resume",
): number {
  return intents.filter((intent) => intent === target).length;
}

function formatSelectionSummary(
  stats: SelectionSummaryStats,
  t: TFunction<"components">,
): string {
  const { hasUnloadedSelection, loadedSelections, restartCount, resumeCount } =
    stats;
  if (resumeCount + restartCount === 0) {
    return t("chapterPicker.noSelectedPages");
  }
  if (loadedSelections.length === 1 && !hasUnloadedSelection) {
    const contiguous = summarizeContiguousSelection(loadedSelections[0], t);
    if (contiguous) return contiguous;
  }
  if (resumeCount > 0 && restartCount > 0) {
    return t("chapterPicker.resumeSummary.mixed", {
      resumeCount,
      restartCount,
    });
  }
  if (resumeCount > 0) {
    return t("chapterPicker.resumeSummary.resumeOnly", { resumeCount });
  }
  return t("chapterPicker.resumeSummary.restartOnly", { restartCount });
}

function resolveResumeTooltip(
  intent: "none" | "restart" | "resume",
  page: MangaPage,
  t: TFunction<"components">,
): string | undefined {
  if (intent !== "resume") return undefined;
  if (page.translationCheckpoint) {
    return t("chapterPicker.resumeTooltip.translation");
  }
  if ((page.translationCompletion?.erasedBlockIds?.length ?? 0) > 0) {
    return t("chapterPicker.resumeTooltip.erasePartial");
  }
  return t("chapterPicker.resumeTooltip.typography");
}

function summarizeContiguousSelection(
  selection: {
    pages: MangaPage[];
    intents: Array<"none" | "restart" | "resume">;
  },
  t: TFunction<"components">,
): string | undefined {
  const resumeIndexes = indexesOf(selection.intents, "resume");
  const restartIndexes = indexesOf(selection.intents, "restart");
  const resumesFromStart = isRange(resumeIndexes, 0);
  const restartsAfterResume = isRange(restartIndexes, resumeIndexes.length);
  const coversWholeChapter =
    resumeIndexes.length + restartIndexes.length === selection.pages.length;
  if (
    resumeIndexes.length > 0 &&
    restartIndexes.length > 0 &&
    resumesFromStart &&
    restartsAfterResume &&
    coversWholeChapter
  ) {
    return resumeIndexes.length === 1
      ? t("chapterPicker.resumeSummary.contiguousSingle", {
          resumePage: 1,
          restartStart: 2,
        })
      : t("chapterPicker.resumeSummary.contiguous", {
          resumeStart: 1,
          resumeEnd: resumeIndexes.length,
          restartStart: resumeIndexes.length + 1,
        });
  }
  if (
    resumeIndexes.length > 0 &&
    restartIndexes.length === 0 &&
    resumesFromStart
  ) {
    const postprocess = selection.pages
      .filter((_page, index) => resumeIndexes.includes(index))
      .every((page) => !page.translationCheckpoint);
    if (postprocess) {
      return resumeIndexes.length === 1
        ? t("chapterPicker.resumeSummary.postprocessSingle", {
            resumePage: 1,
          })
        : t("chapterPicker.resumeSummary.postprocess", {
            resumeStart: 1,
            resumeEnd: resumeIndexes.length,
          });
    }
  }
  return undefined;
}

function indexesOf(
  intents: Array<"none" | "restart" | "resume">,
  target: "restart" | "resume",
): number[] {
  return intents.flatMap((intent, index) => (intent === target ? [index] : []));
}

function isRange(indexes: number[], start: number): boolean {
  return indexes.every((value, offset) => value === start + offset);
}
