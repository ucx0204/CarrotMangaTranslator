/* eslint-disable max-lines-per-function */
import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryChapterSummary,
  LibraryWorkSummary,
  MangaPage,
} from "../../../shared/libraryTypes";
import { mangaGateway } from "../api/mangaGateway";
import {
  chapterTriState,
  selectedPageIds,
  toggleChapter,
  togglePage,
  type ChapterSel,
  type ChapterSelectionMap,
} from "../lib/translationSelection";
import { PageThumb, TriCheckbox } from "./ChapterPickerTiles";
import { Button } from "./ui";

type ChapterPagePickerProps = {
  work: LibraryWorkSummary;
  currentChapter: ChapterSnapshot;
  selection: ChapterSelectionMap;
  onChange: (next: ChapterSelectionMap) => void;
};

type ChapterPagesLoader = {
  getPages: (chapterId: string) => MangaPage[] | undefined;
  isLoading: (chapterId: string) => boolean;
  isErrored: (chapterId: string) => boolean;
  ensureLoaded: (chapterId: string) => void;
};

/** Lazily hydrates chapters that aren't the open one; open chapter is in memory. */
function useChapterPagesLoader(
  currentChapter: ChapterSnapshot,
): ChapterPagesLoader {
  const [pages, setPages] = React.useState<Map<string, MangaPage[]>>(
    () => new Map([[currentChapter.id, currentChapter.pages]]),
  );
  const [loading, setLoading] = React.useState<Set<string>>(() => new Set());
  const [errored, setErrored] = React.useState<Set<string>>(() => new Set());
  const requested = React.useRef<Set<string>>(new Set([currentChapter.id]));

  React.useEffect(() => {
    setPages((prev) =>
      new Map(prev).set(currentChapter.id, currentChapter.pages),
    );
    requested.current.add(currentChapter.id);
  }, [currentChapter]);

  const ensureLoaded = React.useCallback((chapterId: string) => {
    if (requested.current.has(chapterId)) {
      return;
    }
    requested.current.add(chapterId);
    setLoading((prev) => new Set(prev).add(chapterId));
    void mangaGateway
      .openChapter(chapterId)
      .then((snapshot) => {
        setPages((prev) => new Map(prev).set(chapterId, snapshot.pages));
      })
      .catch((error) => {
        console.error(error);
        requested.current.delete(chapterId);
        setErrored((prev) => new Set(prev).add(chapterId));
      })
      .finally(() => {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(chapterId);
          return next;
        });
      });
  }, []);

  return {
    getPages: (chapterId) => pages.get(chapterId),
    isLoading: (chapterId) => loading.has(chapterId),
    isErrored: (chapterId) => errored.has(chapterId),
    ensureLoaded,
  };
}

export function ChapterPagePicker({
  work,
  currentChapter,
  selection,
  onChange,
}: ChapterPagePickerProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const loader = useChapterPagesLoader(currentChapter);
  const [expanded, setExpanded] = React.useState<Set<string>>(
    () => new Set([currentChapter.id]),
  );

  const toggleExpand = (chapterId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(chapterId)) {
        next.delete(chapterId);
      } else {
        next.add(chapterId);
        loader.ensureLoaded(chapterId);
      }
      return next;
    });
  };

  const setEveryChapter = (make: () => ChapterSel): void => {
    onChange(new Map(work.chapters.map((chapter) => [chapter.id, make()])));
  };

  return (
    <section className="translate-picker">
      <div className="translate-picker-head">
        <div className="translate-picker-heading">
          <div className="translate-picker-worktitle">{work.title}</div>
          <div className="translate-picker-subtitle">
            {t("chapterPicker.prompt")}
          </div>
        </div>
        <div className="translate-picker-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEveryChapter(() => ({ kind: "all" }))}
          >
            {t("common.selectAll")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEveryChapter(() => ({ kind: "pending" }))}
          >
            {t("chapterPicker.untranslatedOnly")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onChange(new Map())}>
            {t("common.clearAll")}
          </Button>
        </div>
      </div>

      <div className="translate-picker-list">
        {work.chapters.map((chapter) => (
          <ChapterRow
            key={chapter.id}
            chapter={chapter}
            isCurrent={chapter.id === currentChapter.id}
            expanded={expanded.has(chapter.id)}
            sel={selection.get(chapter.id)}
            pages={loader.getPages(chapter.id)}
            loading={loader.isLoading(chapter.id)}
            errored={loader.isErrored(chapter.id)}
            onToggleExpand={() => toggleExpand(chapter.id)}
            onToggleChapter={() =>
              onChange(toggleChapter(selection, chapter.id))
            }
            onTogglePage={(pageId) =>
              onChange(
                togglePage(
                  selection,
                  chapter.id,
                  pageId,
                  loader.getPages(chapter.id) ?? [],
                ),
              )
            }
          />
        ))}
        {work.chapters.length === 0 ? (
          <p className="translate-picker-note">
            {t("chapterPicker.noChapters")}
          </p>
        ) : null}
      </div>

      <div className="translate-picker-summary">
        {summarizeSelection(work, selection, loader, t)}
      </div>
    </section>
  );
}

function ChapterRow({
  chapter,
  isCurrent,
  expanded,
  sel,
  pages,
  loading,
  errored,
  onToggleExpand,
  onToggleChapter,
  onTogglePage,
}: {
  chapter: LibraryChapterSummary;
  isCurrent: boolean;
  expanded: boolean;
  sel: ChapterSel | undefined;
  pages: MangaPage[] | undefined;
  loading: boolean;
  errored: boolean;
  onToggleExpand: () => void;
  onToggleChapter: () => void;
  onTogglePage: (pageId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const tri = chapterTriState(sel, chapter.pageCount, pages);
  const checkedIds = selectedPageIds(sel, pages ?? []);

  return (
    <div className={`translate-chapter-row ${expanded ? "expanded" : ""}`}>
      <div className="translate-chapter-head">
        <TriCheckbox
          state={tri}
          label={chapter.title}
          onChange={onToggleChapter}
        />
        <button
          type="button"
          className="translate-chapter-toggle"
          aria-expanded={expanded}
          onClick={onToggleExpand}
        >
          <span className="translate-chapter-caret" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
          <span className="translate-chapter-title">{chapter.title}</span>
          {isCurrent ? (
            <span className="translate-chapter-tag">
              {t("chapterPicker.currentChapter")}
            </span>
          ) : null}
          <span className="translate-chapter-summary">
            {resolveChapterSummary(chapter, pages, t)}
          </span>
        </button>
      </div>
      {expanded ? (
        <div className="translate-chapter-body">
          <ChapterPages
            pages={pages}
            loading={loading}
            errored={errored}
            checkedIds={checkedIds}
            onTogglePage={onTogglePage}
          />
        </div>
      ) : null}
    </div>
  );
}

function ChapterPages({
  pages,
  loading,
  errored,
  checkedIds,
  onTogglePage,
}: {
  pages: MangaPage[] | undefined;
  loading: boolean;
  errored: boolean;
  checkedIds: Set<string>;
  onTogglePage: (pageId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (loading || !pages) {
    return (
      <p className="translate-picker-note">{t("chapterPicker.loadingPages")}</p>
    );
  }
  if (errored) {
    return (
      <p className="translate-picker-note">
        {t("chapterPicker.loadPagesFailed")}
      </p>
    );
  }
  if (pages.length === 0) {
    return (
      <p className="translate-picker-note">{t("chapterPicker.noPages")}</p>
    );
  }
  return (
    <div className="translate-page-grid">
      {pages.map((page, index) => (
        <PageThumb
          key={page.id}
          page={page}
          index={index}
          checked={checkedIds.has(page.id)}
          onToggle={() => onTogglePage(page.id)}
        />
      ))}
    </div>
  );
}

function resolveChapterSummary(
  chapter: LibraryChapterSummary,
  pages: MangaPage[] | undefined,
  t: TFunction<"components">,
): string {
  if (pages) {
    const remaining = pages.filter(
      (page) => page.analysisStatus !== "completed",
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
  loader: ChapterPagesLoader,
  t: TFunction<"components">,
): string {
  let chapters = 0;
  let pages = 0;
  let approximate = false;
  for (const chapter of work.chapters) {
    const sel = selection.get(chapter.id);
    if (!sel) {
      continue;
    }
    chapters += 1;
    const loaded = loader.getPages(chapter.id);
    if (sel.kind === "pages") {
      pages += sel.pageIds.size;
    } else if (sel.kind === "all") {
      pages += loaded ? loaded.length : chapter.pageCount;
    } else if (loaded) {
      pages += loaded.filter(
        (page) => page.analysisStatus !== "completed",
      ).length;
    } else {
      pages += chapter.pageCount;
      approximate = true;
    }
  }
  if (chapters === 0) {
    return t("chapterPicker.noSelectedPages");
  }
  return t("chapterPicker.selectionSummary", {
    chapterCount: chapters,
    pageCount: pages,
    approximate: approximate ? t("chapterPicker.approximately") : "",
  });
}
