import React from "react";
import { IconCircleCheck, IconDownload, IconEye } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { JobProgressReadout } from "./JobProgressReadout";
import { Button } from "./ui/Button";
import { InlineMessage } from "./ui/InlineMessage";

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
      <InlineMessage
        title={jobState.progressText}
        detail={jobState.detail?.trim() || undefined}
        variant="danger"
      />
    );
  }
  if (jobState.status === "partial") {
    return (
      <InlineMessage
        title={jobState.progressText}
        detail={
          jobState.detail?.trim() &&
          jobState.detail.trim() !== jobState.progressText.trim()
            ? jobState.detail
            : undefined
        }
        variant="warning"
      />
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
  return (
    <div className="progress-card">
      <JobProgressReadout
        jobState={jobState}
        progressSnapshot={progressSnapshot}
      />
    </div>
  );
}
