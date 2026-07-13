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
  chapterTriState,
  selectedPageIds,
  toggleChapter,
  togglePage,
  type ChapterSel,
  type ChapterSelectionMap,
} from "../lib/translationSelection";
import { Button } from "./ui";
import { WorkPagePicker, type ChapterPagesLookup } from "./WorkPagePicker";

type ChapterPagePickerProps = {
  work: LibraryWorkSummary;
  currentChapter: ChapterSnapshot;
  selection: ChapterSelectionMap;
  onChange: (next: ChapterSelectionMap) => void;
};

export function ChapterPagePicker({
  work,
  currentChapter,
  selection,
  onChange,
}: ChapterPagePickerProps): React.JSX.Element {
  const { t } = useTranslation("components");

  const setEveryChapter = (make: () => ChapterSel): void => {
    onChange(new Map(work.chapters.map((chapter) => [chapter.id, make()])));
  };

  return (
    <WorkPagePicker
      work={work}
      currentChapter={currentChapter}
      header={
        <ChapterPickerHeader
          workTitle={work.title}
          onSelectAll={() => setEveryChapter(() => ({ kind: "all" }))}
          onSelectPending={() => setEveryChapter(() => ({ kind: "pending" }))}
          onClear={() => onChange(new Map())}
        />
      }
      getChapterTriState={(chapter, pages) =>
        chapterTriState(selection.get(chapter.id), chapter.pageCount, pages)
      }
      getSelectedPageIds={(chapter, pages) =>
        selectedPageIds(selection.get(chapter.id), pages)
      }
      getChapterSummary={(chapter, pages) =>
        resolveChapterSummary(chapter, pages, t)
      }
      renderSelectionSummary={(getPages) =>
        summarizeSelection(work, selection, getPages, t)
      }
      onToggleChapter={(chapterId) =>
        onChange(toggleChapter(selection, chapterId))
      }
      onTogglePage={(chapterId, pageId, pages) =>
        onChange(togglePage(selection, chapterId, pageId, pages))
      }
    />
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
  getPages: ChapterPagesLookup,
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
    const loaded = getPages(chapter.id);
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
