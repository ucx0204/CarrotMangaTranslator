/* eslint-disable max-lines-per-function */
import React from "react";
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
          <div className="translate-picker-subtitle">무엇을 번역할까요?</div>
        </div>
        <div className="translate-picker-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEveryChapter(() => ({ kind: "all" }))}
          >
            전체 선택
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEveryChapter(() => ({ kind: "pending" }))}
          >
            미번역만
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onChange(new Map())}>
            전체 해제
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
          <p className="translate-picker-note">화가 없습니다.</p>
        ) : null}
      </div>

      <div className="translate-picker-summary">
        {summarizeSelection(work, selection, loader)}
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
            <span className="translate-chapter-tag">현재 화</span>
          ) : null}
          <span className="translate-chapter-summary">
            {resolveChapterSummary(chapter, pages)}
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
  if (loading || !pages) {
    return <p className="translate-picker-note">페이지 불러오는 중…</p>;
  }
  if (errored) {
    return (
      <p className="translate-picker-note">페이지를 불러오지 못했습니다.</p>
    );
  }
  if (pages.length === 0) {
    return <p className="translate-picker-note">페이지가 없습니다.</p>;
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
): string {
  if (pages) {
    const remaining = pages.filter(
      (page) => page.analysisStatus !== "completed",
    ).length;
    return remaining === 0
      ? `${pages.length}p · 완료`
      : `${pages.length}p · ${remaining} 남음`;
  }
  const suffix =
    chapter.status === "completed"
      ? " · 완료"
      : chapter.status === "partial"
        ? " · 진행 중"
        : "";
  return `${chapter.pageCount}p${suffix}`;
}

function summarizeSelection(
  work: LibraryWorkSummary,
  selection: ChapterSelectionMap,
  loader: ChapterPagesLoader,
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
    return "선택된 페이지가 없습니다.";
  }
  return `${chapters}개 화 · ${approximate ? "약 " : ""}${pages}페이지`;
}
