import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type {
  AppOperationActivityEvent,
  AppOperationKind,
  AppOperationStatus,
} from "../../../shared/appOperationTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { formatAppOperationActivity } from "../lib/appOperationPresentation";
import type { StatusCenterHistoryEntry } from "../lib/statusCenterHistoryStore";
import { JobCancelButton } from "./RunStatusPanels";
import { RunJobFeedback } from "./RunStatusFeedback";
import { StatusOperationActivityFeedback } from "./StatusOperationActivityFeedback";

const RECENT_JOB_VISIBLE_LIMIT = 3;

export function CurrentStatusContent({
  jobState,
  operationActivity,
  progressSnapshot,
  showProgressBar,
  onCancelJob,
  onCancelOperation,
  onOpenExport,
  onReviewResults,
}: {
  jobState: JobState;
  operationActivity?: AppOperationActivityEvent | null;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
  onCancelJob: () => void;
  onCancelOperation?: () => void;
  onOpenExport?: () => void;
  onReviewResults?: () => void;
}): React.JSX.Element {
  const { t: rendererT } = useTranslation("renderer");
  const status = operationActivity?.status ?? jobState.status;
  const statusText = operationActivity
    ? formatAppOperationActivity(operationActivity, rendererT)
    : jobState.progressText;
  if (operationActivity) {
    return (
      <>
        <div className={`job-pill ${status}`} role="status">
          {statusText}
        </div>
        <StatusOperationActivityFeedback
          activity={operationActivity}
          onCancel={onCancelOperation}
        />
      </>
    );
  }
  const jobActive = ["starting", "running", "cancelling"].includes(status);
  if (jobActive && jobState.kind === "internet-research" && jobState.research) {
    return (
      <>
        <ResearchJobDetails jobState={jobState} />
        <JobCancelButton
          cancelling={jobState.status === "cancelling"}
          onCancel={onCancelJob}
        />
      </>
    );
  }
  const feedbackVisible = willRenderRunJobFeedback(
    jobState,
    progressSnapshot,
    showProgressBar,
  );
  return (
    <>
      {!feedbackVisible ? (
        <div className={`job-pill ${status}`} role="status">
          {statusText}
        </div>
      ) : null}
      <RunJobFeedback
        jobState={jobState}
        progressSnapshot={progressSnapshot}
        showProgressBar={showProgressBar}
        onOpenExport={onOpenExport}
        onReviewResults={onReviewResults}
      />
      {jobActive ? (
        <JobCancelButton
          cancelling={jobState.status === "cancelling"}
          onCancel={onCancelJob}
        />
      ) : null}
    </>
  );
}

function willRenderRunJobFeedback(
  jobState: JobState,
  progressSnapshot: ProgressSnapshot | null,
  showProgressBar: boolean,
): boolean {
  if (["failed", "partial", "completed"].includes(jobState.status)) {
    return true;
  }
  if (
    progressSnapshot?.mode === "determinate" &&
    (progressSnapshot.current >= progressSnapshot.total ||
      progressSnapshot.ratio >= 1)
  ) {
    return false;
  }
  return showProgressBar && progressSnapshot !== null;
}

export function ResearchJobDetails({
  jobState,
}: {
  jobState: JobState;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const research = jobState.research;
  if (jobState.kind !== "internet-research" || !research) return null;
  return (
    <section className="status-operation-details" aria-live="polite">
      <h3>{t("statusDock.research.title")}</h3>
      <strong>
        {t(`styleGuide.research.progress.stages.${research.stage}.title`)}
      </strong>
      {research.query ? <small>{research.query}</small> : null}
      {research.creditsUsed !== undefined && research.creditLimit ? (
        <small>
          {t("statusDock.research.credits", {
            used: research.creditsUsed,
            limit: research.creditLimit,
          })}
        </small>
      ) : null}
    </section>
  );
}

export function StatusJobHistory({
  entries,
}: {
  entries: StatusCenterHistoryEntry[];
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const { t: rendererT } = useTranslation("renderer");
  if (!entries.length) return null;
  const scrollable = entries.length > RECENT_JOB_VISIBLE_LIMIT;
  return (
    <section
      className="status-job-history"
      aria-label={t("statusDock.recentJobs")}
    >
      <h3>{t("statusDock.recentJobs")}</h3>
      <ul
        aria-label={t("statusDock.recentJobs")}
        className={scrollable ? "scrollable" : undefined}
        data-visible-limit={RECENT_JOB_VISIBLE_LIMIT}
        tabIndex={scrollable ? 0 : undefined}
      >
        {entries.map((entry) => (
          <li key={`${entry.id}-${entry.status}`}>
            <span
              className={`status-history-mark ${entry.status}`}
              aria-hidden="true"
            />
            <span>
              <strong>{formatHistoryEntryLabel(entry, t, rendererT)}</strong>
              {entry.pageTotal ? (
                <small>
                  {t("statusDock.completedPages", { count: entry.pageTotal })}
                </small>
              ) : null}
              {entry.failureCode ? (
                <small>
                  {t("statusDock.history.failureCode", {
                    code: entry.failureCode,
                  })}
                </small>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatHistoryEntryLabel(
  entry: StatusCenterHistoryEntry,
  t: TFunction<"components">,
  rendererT: TFunction<"renderer">,
): string {
  if (entry.source === "operation") {
    return formatAppOperationActivity(
      {
        kind: entry.kind as AppOperationKind,
        status: entry.status as AppOperationStatus,
        phase: entry.phase,
        sourceKind: entry.sourceKind,
      },
      rendererT,
    );
  }
  if (entry.progressText) return entry.progressText;
  const kind = t(`statusDock.history.kind.${entry.kind}`);
  const status = t(`statusDock.history.status.${entry.status}`);
  return t("statusDock.history.summary", { kind, status });
}
