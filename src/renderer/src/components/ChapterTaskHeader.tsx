import React from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";

export type ChapterTaskHeaderProps = {
  currentChapter: ChapterSnapshot | null;
};

export function ChapterTaskHeader({
  currentChapter,
}: ChapterTaskHeaderProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const title = currentChapter?.title ?? t("sidebar.noCurrentChapter");
  const summary = currentChapter
    ? t("common.pageCount", { count: currentChapter.pages.length })
    : t("runPanel.openChapterHint");
  return (
    <div className="chapter-task-header">
      <h2 title={title}>{title}</h2>
      <small title={summary}>{summary}</small>
    </div>
  );
}
