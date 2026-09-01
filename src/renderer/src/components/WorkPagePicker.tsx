import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryChapterSummary,
  LibraryWorkSummary,
  MangaPage,
} from "../../../shared/libraryTypes";
import { libraryGateway as mangaGateway } from "../api/libraryGateway";
import { useMountedRef } from "../hooks/useMountedRef";
import type { TriState } from "../lib/translationSelection";
import { PageThumb, TriCheckbox } from "./ChapterPickerTiles";
import {
  usePageThumbnailObserver,
  useScrollToCurrentPage,
  type ObservePageThumbnail,
} from "./pageThumbnails";

export type ChapterPagesLookup = (chapterId: string) => MangaPage[] | undefined;

type WorkPagePickerProps = {
  work: LibraryWorkSummary;
  currentChapter: ChapterSnapshot;
  currentPageId?: string | null;
  header: React.ReactNode;
  getChapterTriState: (
    chapter: LibraryChapterSummary,
    pages: MangaPage[] | undefined,
  ) => TriState;
  getSelectedPageIds: (
    chapter: LibraryChapterSummary,
    pages: MangaPage[],
  ) => Set<string>;
  getPageSelectionState?: (
    chapter: LibraryChapterSummary,
    page: MangaPage,
  ) => "none" | "restart" | "resume";
  getPageSelectionTooltip?: (
    chapter: LibraryChapterSummary,
    page: MangaPage,
  ) => string | undefined;
  getChapterSummary: (
    chapter: LibraryChapterSummary,
    pages: MangaPage[] | undefined,
  ) => string;
  renderSelectionSummary: (getPages: ChapterPagesLookup) => React.ReactNode;
  onToggleChapter: (chapterId: string) => void;
  onTogglePage: (chapterId: string, pageId: string, pages: MangaPage[]) => void;
  onTogglePageRange?: (
    chapterId: string,
    pageId: string,
    pages: MangaPage[],
  ) => void;
  showTranslatedStatus?: boolean;
};

type ChapterPagesLoader = {
  getPages: ChapterPagesLookup;
  isLoading: (chapterId: string) => boolean;
  isErrored: (chapterId: string) => boolean;
  ensureLoaded: (chapterId: string) => void;
};

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
  const mountedRef = useMountedRef();

  React.useEffect(() => {
    setPages((prev) =>
      new Map(prev).set(currentChapter.id, currentChapter.pages),
    );
    requested.current.add(currentChapter.id);
  }, [currentChapter]);

  const ensureLoaded = React.useCallback(
    (chapterId: string) => {
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
          if (!mountedRef.current) {
            return;
          }
          setPages((prev) => new Map(prev).set(chapterId, snapshot.pages));
        })
        .catch((error: unknown) => {
          if (!mountedRef.current) {
            return;
          }
          console.error(error);
          requested.current.delete(chapterId);
          setErrored((prev) => new Set(prev).add(chapterId));
        })
        .finally(() => {
          if (!mountedRef.current) {
            return;
          }
          setLoading((prev) => {
            const next = new Set(prev);
            next.delete(chapterId);
            return next;
          });
        });
    },
    [mountedRef],
  );

  return {
    getPages: (chapterId) => pages.get(chapterId),
    isLoading: (chapterId) => loading.has(chapterId),
    isErrored: (chapterId) => errored.has(chapterId),
    ensureLoaded,
  };
}

/** Shared expandable chapter/page picker chrome used by translation and export. */
export function WorkPagePicker(props: WorkPagePickerProps): React.JSX.Element {
  const { currentChapter, currentPageId, header, renderSelectionSummary } =
    props;
  const loader = useChapterPagesLoader(props.currentChapter);
  const pickerListRef = React.useRef<HTMLDivElement>(null);
  const observeThumbnail = usePageThumbnailObserver(pickerListRef);
  const [expanded, setExpanded] = React.useState<Set<string>>(
    () => new Set([currentChapter.id]),
  );
  useScrollToCurrentPage(pickerListRef, currentPageId, expanded);
  const onToggleExpand = (chapterId: string): void => {
    setExpanded((prev) =>
      toggleExpandedChapter(prev, chapterId, loader.ensureLoaded),
    );
  };

  return (
    <section className="translate-picker">
      {header}
      <div ref={pickerListRef} className="translate-picker-list">
        <WorkPagePickerRows
          picker={props}
          loader={loader}
          expanded={expanded}
          observeThumbnail={observeThumbnail}
          onToggleExpand={onToggleExpand}
        />
      </div>
      <div className="translate-picker-summary">
        {renderSelectionSummary(loader.getPages)}
      </div>
    </section>
  );
}

type WorkPagePickerRowsProps = {
  picker: WorkPagePickerProps;
  loader: ChapterPagesLoader;
  expanded: ReadonlySet<string>;
  observeThumbnail: ObservePageThumbnail;
  onToggleExpand: (chapterId: string) => void;
};

function WorkPagePickerRows(props: WorkPagePickerRowsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      {props.picker.work.chapters.map((chapter) => (
        <WorkPagePickerChapter key={chapter.id} chapter={chapter} {...props} />
      ))}
      {props.picker.work.chapters.length === 0 ? (
        <p className="translate-picker-note">{t("chapterPicker.noChapters")}</p>
      ) : null}
    </>
  );
}

function WorkPagePickerChapter({
  chapter,
  picker,
  loader,
  expanded,
  observeThumbnail,
  onToggleExpand,
}: WorkPagePickerRowsProps & {
  chapter: LibraryChapterSummary;
}): React.JSX.Element {
  const pages = loader.getPages(chapter.id);
  const togglePage = (pageId: string, range: boolean): void => {
    if (!pages) return;
    const handler = range ? picker.onTogglePageRange : picker.onTogglePage;
    (handler ?? picker.onTogglePage)(chapter.id, pageId, pages);
  };
  const isCurrent = chapter.id === picker.currentChapter.id;
  return (
    <ChapterRow
      chapter={chapter}
      isCurrent={isCurrent}
      currentPageId={isCurrent ? picker.currentPageId : null}
      expanded={expanded.has(chapter.id)}
      triState={picker.getChapterTriState(chapter, pages)}
      pages={pages}
      selectedPageIds={
        pages ? picker.getSelectedPageIds(chapter, pages) : new Set()
      }
      getPageSelectionState={picker.getPageSelectionState}
      getPageSelectionTooltip={picker.getPageSelectionTooltip}
      chapterSummary={picker.getChapterSummary(chapter, pages)}
      loading={loader.isLoading(chapter.id)}
      errored={loader.isErrored(chapter.id)}
      showTranslatedStatus={picker.showTranslatedStatus ?? true}
      observeThumbnail={observeThumbnail}
      onToggleExpand={() => onToggleExpand(chapter.id)}
      onToggleChapter={() => picker.onToggleChapter(chapter.id)}
      onTogglePage={(pageId) => togglePage(pageId, false)}
      onTogglePageRange={(pageId) => togglePage(pageId, true)}
    />
  );
}

function toggleExpandedChapter(
  expanded: ReadonlySet<string>,
  chapterId: string,
  ensureLoaded: (chapterId: string) => void,
): Set<string> {
  const next = new Set(expanded);
  if (next.delete(chapterId)) return next;
  next.add(chapterId);
  ensureLoaded(chapterId);
  return next;
}

type ChapterRowProps = {
  chapter: LibraryChapterSummary;
  isCurrent: boolean;
  currentPageId?: string | null;
  expanded: boolean;
  triState: TriState;
  pages: MangaPage[] | undefined;
  selectedPageIds: Set<string>;
  getPageSelectionState?: WorkPagePickerProps["getPageSelectionState"];
  getPageSelectionTooltip?: WorkPagePickerProps["getPageSelectionTooltip"];
  chapterSummary: string;
  loading: boolean;
  errored: boolean;
  showTranslatedStatus: boolean;
  observeThumbnail: ObservePageThumbnail;
  onToggleExpand: () => void;
  onToggleChapter: () => void;
  onTogglePage: (pageId: string) => void;
  onTogglePageRange: (pageId: string) => void;
};

function ChapterRow({
  chapter,
  isCurrent,
  currentPageId,
  expanded,
  triState,
  pages,
  selectedPageIds,
  getPageSelectionState,
  getPageSelectionTooltip,
  chapterSummary,
  loading,
  errored,
  showTranslatedStatus,
  observeThumbnail,
  onToggleExpand,
  onToggleChapter,
  onTogglePage,
  onTogglePageRange,
}: ChapterRowProps): React.JSX.Element {
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
            currentPageId={currentPageId}
            loading={loading}
            errored={errored}
            selectedPageIds={selectedPageIds}
            getPageSelectionState={(page) =>
              getPageSelectionState?.(chapter, page)
            }
            getPageSelectionTooltip={(page) =>
              getPageSelectionTooltip?.(chapter, page)
            }
            showTranslatedStatus={showTranslatedStatus}
            observeThumbnail={observeThumbnail}
            onTogglePage={onTogglePage}
            onTogglePageRange={onTogglePageRange}
          />
        </div>
      ) : null}
    </div>
  );
}

function ChapterPages({
  pages,
  currentPageId,
  loading,
  errored,
  selectedPageIds,
  getPageSelectionState,
  getPageSelectionTooltip,
  showTranslatedStatus,
  observeThumbnail,
  onTogglePage,
  onTogglePageRange,
}: {
  pages: MangaPage[] | undefined;
  currentPageId?: string | null;
  loading: boolean;
  errored: boolean;
  selectedPageIds: Set<string>;
  getPageSelectionState?: (
    page: MangaPage,
  ) => "none" | "restart" | "resume" | undefined;
  getPageSelectionTooltip?: (page: MangaPage) => string | undefined;
  showTranslatedStatus: boolean;
  observeThumbnail: ObservePageThumbnail;
  onTogglePage: (pageId: string) => void;
  onTogglePageRange: (pageId: string) => void;
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
          current={page.id === currentPageId}
          selectionState={getPageSelectionState?.(page)}
          selectionTooltip={getPageSelectionTooltip?.(page)}
          showTranslatedStatus={showTranslatedStatus}
          observeThumbnail={observeThumbnail}
          onToggle={({ range }) => {
            if (range) onTogglePageRange(page.id);
            else onTogglePage(page.id);
          }}
        />
      ))}
    </div>
  );
}
