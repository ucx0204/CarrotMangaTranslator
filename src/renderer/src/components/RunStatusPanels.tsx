import React from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { useEtaText } from "../hooks/useEtaText";
import { Button } from "./ui";

export function RunPanel({
  autoInpaintingOpen,
  currentChapter,
  jobActive,
  flowActive,
  showProgressBar,
  progressSnapshot,
  jobState,
  onOpenExport,
  onOpenTranslateOptions,
  onOpenAutoInpaintingOptions,
  onCancelJob,
}: {
  autoInpaintingOpen: boolean;
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  flowActive: boolean;
  showProgressBar: boolean;
  progressSnapshot: ProgressSnapshot | null;
  jobState: JobState;
  onOpenExport: () => void;
  onOpenTranslateOptions: () => void;
  onOpenAutoInpaintingOptions: () => void;
  onCancelJob: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const actionsDisabled = !currentChapter || jobActive || flowActive;
  return (
    <section className="run-panel">
      <div className="run-title">
        <h2>{currentChapter?.title ?? t("sidebar.noCurrentChapter")}</h2>
        <small>
          {currentChapter
            ? t("common.pageCount", { count: currentChapter.pages.length })
            : t("runPanel.openChapterHint")}
        </small>
      </div>
      <div className="run-primary-actions">
        <Button
          variant="primary"
          fullWidth
          onClick={onOpenTranslateOptions}
          disabled={actionsDisabled}
        >
          {t("sidebar.translate")}
        </Button>
        <Button
          className={autoInpaintingOpen ? "active" : ""}
          fullWidth
          aria-pressed={autoInpaintingOpen}
          onClick={onOpenAutoInpaintingOptions}
          disabled={actionsDisabled}
        >
          {t("inpainting.inspector.autoAction")}
        </Button>
        <Button fullWidth onClick={onOpenExport} disabled={actionsDisabled}>
          {t("inpainting.export.pngAction")}
        </Button>
      </div>
      {jobActive ? (
        <Button variant="danger" fullWidth onClick={onCancelJob}>
          {t("common.cancel")}
        </Button>
      ) : null}
      {showProgressBar && progressSnapshot ? (
        <ProgressCard jobState={jobState} progressSnapshot={progressSnapshot} />
      ) : null}
    </section>
  );
}

export function StatusPanel({
  jobState,
  statusLines,
}: {
  jobState: JobState;
  statusLines: string[];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="status-panel">
      <h2>{t("status.title")}</h2>
      <div
        className={`job-pill ${jobState.status}`}
        role="status"
        aria-live="polite"
      >
        {jobState.progressText}
      </div>
      <div className="status-log-scroll">
        {statusLines.length ? (
          statusLines.map((line, index) => (
            <p key={`${line}-${index}`}>{line}</p>
          ))
        ) : (
          <p className="muted-line">{t("status.empty")}</p>
        )}
      </div>
    </section>
  );
}

function ProgressCard({
  jobState,
  progressSnapshot,
}: {
  jobState: JobState;
  progressSnapshot: ProgressSnapshot;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const etaText = useEtaText(progressSnapshot);
  return (
    <div className="progress-card">
      <div className="progress-meta">
        <span>{jobState.progressText}</span>
        {progressSnapshot.mode === "determinate" ? (
          <strong>
            {progressSnapshot.current} / {progressSnapshot.total}
          </strong>
        ) : (
          <strong>{t("common.preparing")}</strong>
        )}
      </div>
      {jobState.detail ? (
        <small className="progress-detail">{jobState.detail}</small>
      ) : null}
      {etaText ? <small className="progress-eta">{etaText}</small> : null}
      <div
        className={`progress-track ${progressSnapshot.mode === "indeterminate" ? "indeterminate" : ""}`}
        aria-hidden="true"
      >
        <div
          className={`progress-fill ${progressSnapshot.mode === "indeterminate" ? "indeterminate" : ""}`}
          style={
            progressSnapshot.mode === "determinate"
              ? { width: `${Math.round(progressSnapshot.ratio * 100)}%` }
              : undefined
          }
        />
      </div>
    </div>
  );
}
