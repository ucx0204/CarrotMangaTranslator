import React from "react";
import { IconCircleCheck, IconDownload, IconEye } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { useEtaText } from "../hooks/useEtaText";
import { Button } from "./ui/Button";

export function RunJobFeedback({
  jobState,
  progressSnapshot,
  showProgressBar,
  onOpenExport,
  onReviewResults,
}: {
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
  onOpenExport?: () => void;
  onReviewResults?: () => void;
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
  if (jobState.status === "completed") {
    return (
      <CompletedJobCard
        jobState={jobState}
        onOpenExport={onOpenExport}
        onReviewResults={onReviewResults}
      />
    );
  }
  if (isCompleteProgressSnapshot(progressSnapshot)) {
    return null;
  }
  if (!showProgressBar || !progressSnapshot) return null;
  return (
    <ProgressCard jobState={jobState} progressSnapshot={progressSnapshot} />
  );
}

function CompletedJobCard({
  jobState,
  onOpenExport,
  onReviewResults,
}: {
  jobState: JobState;
  onOpenExport?: () => void;
  onReviewResults?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const pageCount = jobState.pageTotal ?? jobState.progressTotal;
  const showResultActions = jobState.kind !== "page-export";
  const detail = jobState.detail?.trim();
  return (
    <div className="job-completed-card" role="status">
      <div className="job-completed-heading">
        <IconCircleCheck size={22} stroke={2.2} aria-hidden="true" />
        <div>
          <strong>{t("statusDock.completedTitle")}</strong>
          {pageCount ? (
            <span>{t("statusDock.completedPages", { count: pageCount })}</span>
          ) : null}
        </div>
      </div>
      {detail && detail !== jobState.progressText.trim() ? (
        <p>{detail}</p>
      ) : null}
      {showResultActions && (onReviewResults || onOpenExport) ? (
        <div className="job-completed-actions">
          {onReviewResults ? (
            <Button
              fullWidth
              size="sm"
              iconLeft={<IconEye size={16} stroke={2.1} />}
              onClick={onReviewResults}
            >
              {t("statusDock.reviewResults")}
            </Button>
          ) : null}
          {onOpenExport ? (
            <Button
              fullWidth
              size="sm"
              variant="primary"
              iconLeft={<IconDownload size={16} stroke={2.1} />}
              onClick={onOpenExport}
            >
              {t("statusDock.exportResults")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
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
        role="progressbar"
        aria-label={jobState.progressText}
        aria-valuemin={0}
        aria-valuemax={
          progressSnapshot.mode === "determinate"
            ? progressSnapshot.total
            : undefined
        }
        aria-valuenow={
          progressSnapshot.mode === "determinate"
            ? progressSnapshot.current
            : undefined
        }
        aria-valuetext={
          progressSnapshot.mode === "determinate"
            ? `${progressSnapshot.current} / ${progressSnapshot.total}`
            : t("common.preparing")
        }
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
