import React from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { ChapterSaveStatus } from "../hooks/chapterPersistenceTypes";

export type ChapterTaskHeaderProps = {
  currentChapter: ChapterSnapshot | null;
  saveStatus: ChapterSaveStatus;
  onRetrySave: () => void;
};

export function ChapterTaskHeader({
  currentChapter,
  saveStatus,
  onRetrySave,
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
      <ChapterSaveStatusIndicator
        saveStatus={saveStatus}
        onRetrySave={onRetrySave}
      />
    </div>
  );
}

function ChapterSaveStatusIndicator({
  saveStatus,
  onRetrySave,
}: {
  saveStatus: ChapterSaveStatus;
  onRetrySave: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (saveStatus === "idle") return null;
  return (
    <div
      className={`chapter-save-status ${saveStatus}`}
      role="status"
      aria-live="polite"
    >
      <span>{t(`chapterSave.${saveStatus}`)}</span>
      {saveStatus === "error" ? (
        <button type="button" onClick={onRetrySave}>
          {t("chapterSave.retry")}
        </button>
      ) : null}
    </div>
  );
}
