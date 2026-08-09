import React, { useEffect, useState } from "react";
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
      <div className="chapter-task-title">
        <h2 title={title}>{title}</h2>
        {saveStatus === "saved" ? <ChapterSavedBadge /> : null}
      </div>
      <small title={summary}>{summary}</small>
      <ChapterSaveStatusIndicator
        saveStatus={saveStatus}
        onRetrySave={onRetrySave}
      />
    </div>
  );
}

const SAVED_BADGE_DURATION_MS = 3_000;

function ChapterSavedBadge(): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => setVisible(false),
      SAVED_BADGE_DURATION_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, []);

  if (!visible) return null;
  return (
    <span className="chapter-saved-badge" role="status" aria-live="polite">
      {t("chapterSave.saved")}
    </span>
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
  if (saveStatus === "idle" || saveStatus === "saved") return null;
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
