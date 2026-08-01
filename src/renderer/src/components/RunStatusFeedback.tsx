import React from "react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { useEtaText } from "../hooks/useEtaText";

export function RunJobFeedback({
  jobState,
  progressSnapshot,
  showProgressBar,
}: {
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
}): React.JSX.Element | null {
  if (jobState.status === "failed") {
    return (
      <div className="job-failure-card" role="alert">
        <strong>{jobState.progressText}</strong>
        {jobState.detail?.trim() ? <p>{jobState.detail}</p> : null}
      </div>
    );
  }
  if (jobState.status === "partial") {
    return (
      <div className="job-partial-card" role="status">
        <strong>{jobState.progressText}</strong>
        {jobState.detail?.trim() &&
        jobState.detail.trim() !== jobState.progressText.trim() ? (
          <p>{jobState.detail}</p>
        ) : null}
      </div>
    );
  }
  if (
    jobState.status === "completed" ||
    isCompleteProgressSnapshot(progressSnapshot)
  ) {
    return null;
  }
  if (!showProgressBar || !progressSnapshot) return null;
  return (
    <ProgressCard jobState={jobState} progressSnapshot={progressSnapshot} />
  );
}

function isCompleteProgressSnapshot(
  progressSnapshot: ProgressSnapshot | null,
): boolean {
  return (
    progressSnapshot?.mode === "determinate" &&
    (progressSnapshot.current >= progressSnapshot.total ||
      progressSnapshot.ratio >= 1)
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
