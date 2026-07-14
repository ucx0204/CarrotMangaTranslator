import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryChapterSummary,
  LibraryWorkSummary,
  MangaPage,
} from "../../../shared/libraryTypes";
import { mangaGateway } from "../api/mangaGateway";
import type { TriState } from "../lib/translationSelection";
import {
  PageThumb,
  TriCheckbox,
  type ObservePageThumbnail,
} from "./ChapterPickerTiles";

export type ChapterPagesLookup = (chapterId: string) => MangaPage[] | undefined;

type WorkPagePickerProps = {
  work: LibraryWorkSummary;
  currentChapter: ChapterSnapshot;
  header: React.ReactNode;
  getChapterTriState: (
    chapter: LibraryChapterSummary,
    pages: MangaPage[] | undefined,
  ) => TriState;
  getSelectedPageIds: (
    chapter: LibraryChapterSummary,
    pages: MangaPage[],
  ) => Set<string>;
  getChapterSummary: (
    chapter: LibraryChapterSummary,
    pages: MangaPage[] | undefined,
  ) => string;
  renderSelectionSummary: (getPages: ChapterPagesLookup) => React.ReactNode;
  onToggleChapter: (chapterId: string) => void;
  onTogglePage: (chapterId: string, pageId: string, pages: MangaPage[]) => void;
  showTranslatedStatus?: boolean;
};

type ChapterPagesLoader = {
  getPages: ChapterPagesLookup;
  isLoading: (chapterId: string) => boolean;
  isErrored: (chapterId: string) => boolean;
  ensureLoaded: (chapterId: string) => void;
};

function usePageThumbnailObserver(
  rootRef: React.RefObject<HTMLDivElement | null>,
): ObservePageThumbnail {
  const callbacksRef = React.useRef<Map<Element, () => void>>(new Map());
  const observerRef = React.useRef<IntersectionObserver | null>(null);

  const observeThumbnail = React.useCallback<ObservePageThumbnail>(
    (element, onVisible) => {
      if (typeof IntersectionObserver === "undefined") {
        onVisible();
        return () => undefined;
      }

      callbacksRef.current.set(element, onVisible);
      observerRef.current?.observe(element);
      return () => {
        if (callbacksRef.current.get(element) !== onVisible) {
          return;
        }
        callbacksRef.current.delete(element);
        observerRef.current?.unobserve(element);
      };
    },
    [],
  );

  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          const onVisible = callbacksRef.current.get(entry.target);
          if (!onVisible) {
            continue;
          }
          callbacksRef.current.delete(entry.target);
          observer.unobserve(entry.target);
          onVisible();
        }
      },
      { root, rootMargin: "300px 0px", threshold: 0 },
    );
    observerRef.current = observer;
    for (const element of callbacksRef.current.keys()) {
      observer.observe(element);
    }

    return () => {
      observer.disconnect();
      if (observerRef.current === observer) {
        observerRef.current = null;
      }
    };
  }, [rootRef]);

  return observeThumbnail;
}

/** Lazily hydrates chapters that are expanded; the open chapter is already in memory. */
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
    setErrored((prev) => {
      const next = new Set(prev);
      next.delete(chapterId);
      return next;
    });
    setLoading((prev) => new Set(prev).add(chapterId));
    void mangaGateway
      .openChapter(chapterId)
      .then((snapshot) => {
        setPages((prev) => new Map(prev).set(chapterId, snapshot.pages));
      })
      .catch((error: unknown) => {
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

/** Shared expandable chapter/page picker chrome used by translation and export. */
export function WorkPagePicker({
  work,
  currentChapter,
  header,
  getChapterTriState,
  getSelectedPageIds,
  getChapterSummary,
  renderSelectionSummary,
  onToggleChapter,
  onTogglePage,
  showTranslatedStatus = true,
}: WorkPagePickerProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const loader = useChapterPagesLoader(currentChapter);
  const pickerListRef = React.useRef<HTMLDivElement>(null);
  const observeThumbnail = usePageThumbnailObserver(pickerListRef);
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

  return (
    <section className="translate-picker">
      {header}
      <div ref={pickerListRef} className="translate-picker-list">
        {work.chapters.map((chapter) => {
          const chapterPages = loader.getPages(chapter.id);
          return (
            <ChapterRow
              key={chapter.id}
              chapter={chapter}
              isCurrent={chapter.id === currentChapter.id}
              expanded={expanded.has(chapter.id)}
              triState={getChapterTriState(chapter, chapterPages)}
              pages={chapterPages}
              selectedPageIds={
                chapterPages
                  ? getSelectedPageIds(chapter, chapterPages)
                  : new Set()
              }
              chapterSummary={getChapterSummary(chapter, chapterPages)}
              loading={loader.isLoading(chapter.id)}
              errored={loader.isErrored(chapter.id)}
              showTranslatedStatus={showTranslatedStatus}
              observeThumbnail={observeThumbnail}
              onToggleExpand={() => toggleExpand(chapter.id)}
              onToggleChapter={() => onToggleChapter(chapter.id)}
              onTogglePage={(pageId) => {
                if (chapterPages) {
                  onTogglePage(chapter.id, pageId, chapterPages);
                }
              }}
            />
          );
        })}
        {work.chapters.length === 0 ? (
          <p className="translate-picker-note">
            {t("chapterPicker.noChapters")}
          </p>
        ) : null}
      </div>
      <div className="translate-picker-summary">
        {renderSelectionSummary(loader.getPages)}
      </div>
    </section>
  );
}

function ChapterRow({
  chapter,
  isCurrent,
  expanded,
  triState,
  pages,
  selectedPageIds,
  chapterSummary,
  loading,
  errored,
  showTranslatedStatus,
  observeThumbnail,
  onToggleExpand,
  onToggleChapter,
  onTogglePage,
}: {
  chapter: LibraryChapterSummary;
  isCurrent: boolean;
  expanded: boolean;
  triState: TriState;
  pages: MangaPage[] | undefined;
  selectedPageIds: Set<string>;
  chapterSummary: string;
  loading: boolean;
  errored: boolean;
  showTranslatedStatus: boolean;
  observeThumbnail: ObservePageThumbnail;
  onToggleExpand: () => void;
  onToggleChapter: () => void;
  onTogglePage: (pageId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={`translate-chapter-row ${expanded ? "expanded" : ""}`}>
      <div className="translate-chapter-head">
        <TriCheckbox
          state={triState}
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
          <span className="translate-chapter-summary">{chapterSummary}</span>
        </button>
      </div>
      {expanded ? (
        <div className="translate-chapter-body">
          <ChapterPages
            pages={pages}
            loading={loading}
            errored={errored}
            selectedPageIds={selectedPageIds}
            showTranslatedStatus={showTranslatedStatus}
            observeThumbnail={observeThumbnail}
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
  selectedPageIds,
  showTranslatedStatus,
  observeThumbnail,
  onTogglePage,
}: {
  pages: MangaPage[] | undefined;
  loading: boolean;
  errored: boolean;
  selectedPageIds: Set<string>;
  showTranslatedStatus: boolean;
  observeThumbnail: ObservePageThumbnail;
  onTogglePage: (pageId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (errored) {
    return (
      <p className="translate-picker-note">
        {t("chapterPicker.loadPagesFailed")}
      </p>
    );
  }
  if (loading || !pages) {
    return (
      <p className="translate-picker-note">{t("chapterPicker.loadingPages")}</p>
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
          key={`${page.id}:${page.imagePath}`}
          page={page}
          index={index}
          checked={selectedPageIds.has(page.id)}
          showTranslatedStatus={showTranslatedStatus}
          observeThumbnail={observeThumbnail}
          onToggle={() => onTogglePage(page.id)}
        />
      ))}
    </div>
  );
}
