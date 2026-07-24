import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryWorkSummary,
} from "../../../shared/libraryTypes";
import {
  exportChapterTriState,
  selectedExportPageIds,
  toggleExportChapter,
  toggleExportPage,
  type ExportSelectionMap,
} from "../lib/exportSelection";
import { Button } from "./ui/Button";
import { WorkPagePicker } from "./WorkPagePicker";

export type ExportPagePickerProps = {
  work: LibraryWorkSummary;
  currentChapter: ChapterSnapshot;
  selection: ExportSelectionMap;
  onChange: (next: ExportSelectionMap) => void;
};

type PageSelectionPickerCopy = {
  prompt: string;
  currentChapter: string;
  chapterSummary: (pageCount: number) => string;
  noSelectedPages: string;
  selectionSummary: (chapterCount: number, pageCount: number) => string;
};

export type PageSelectionPickerProps = ExportPagePickerProps & {
  copy: PageSelectionPickerCopy;
};

export function ExportPagePicker({
  work,
  currentChapter,
  selection,
  onChange,
}: ExportPagePickerProps): React.JSX.Element {
  const { t } = useTranslation("components");

  return (
    <PageSelectionPicker
      work={work}
      currentChapter={currentChapter}
      selection={selection}
      onChange={onChange}
      copy={{
        prompt: t("exportOptions.prompt"),
        currentChapter: t("exportOptions.currentChapter"),
        chapterSummary: (count) => t("exportOptions.chapterSummary", { count }),
        noSelectedPages: t("exportOptions.noSelectedPages"),
        selectionSummary: (chapterCount, pageCount) =>
          t("exportOptions.selectionSummary", { chapterCount, pageCount }),
      }}
    />
  );
}

export function PageSelectionPicker({
  work,
  currentChapter,
  selection,
  onChange,
  copy,
}: PageSelectionPickerProps): React.JSX.Element {
  return (
    <WorkPagePicker
      work={work}
      currentChapter={currentChapter}
      header={
        <div className="translate-picker-head">
          <div className="translate-picker-heading">
            <div className="translate-picker-worktitle">{work.title}</div>
            <div className="translate-picker-subtitle">{copy.prompt}</div>
          </div>
          <div className="translate-picker-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onChange(new Map([[currentChapter.id, { kind: "all" }]]))
              }
            >
              {copy.currentChapter}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onChange(
                  new Map(
                    work.chapters.map((chapter) => [
                      chapter.id,
                      { kind: "all" } as const,
                    ]),
                  ),
                )
              }
            >
              <CommonLabel translationKey="selectAll" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(new Map())}
            >
              <CommonLabel translationKey="clearAll" />
            </Button>
          </div>
        </div>
      }
      getChapterTriState={(chapter, pages) =>
        exportChapterTriState(
          selection.get(chapter.id),
          chapter.pageCount,
          pages,
        )
      }
      getSelectedPageIds={(chapter, pages) =>
        selectedExportPageIds(selection.get(chapter.id), pages)
      }
      getChapterSummary={(chapter) => copy.chapterSummary(chapter.pageCount)}
      renderSelectionSummary={() => summarizeSelection(work, selection, copy)}
      onToggleChapter={(chapterId) =>
        onChange(toggleExportChapter(selection, chapterId))
      }
      onTogglePage={(chapterId, pageId, pages) =>
        onChange(toggleExportPage(selection, chapterId, pageId, pages))
      }
      showTranslatedStatus={false}
    />
  );
}

function CommonLabel({
  translationKey,
}: {
  translationKey: "selectAll" | "clearAll";
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return <>{t(`common.${translationKey}`)}</>;
}

function summarizeSelection(
  work: LibraryWorkSummary,
  selection: ExportSelectionMap,
  copy: PageSelectionPickerCopy,
): string {
  let chapterCount = 0;
  let pageCount = 0;
  for (const chapter of work.chapters) {
    const selected = selection.get(chapter.id);
    if (!selected) {
      continue;
    }
    chapterCount += 1;
    pageCount +=
      selected.kind === "all" ? chapter.pageCount : selected.pageIds.size;
  }
  if (chapterCount === 0) {
    return copy.noSelectedPages;
  }
  return copy.selectionSummary(chapterCount, pageCount);
}
