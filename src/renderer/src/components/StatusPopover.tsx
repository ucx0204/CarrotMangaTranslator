import React from "react";
import {
  IconFolderOpen,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { RunJobFeedback } from "./RunStatusFeedback";
import { JobCancelButton } from "./RunStatusPanels";
import { IconButton } from "./ui/IconButton";
import { Button } from "./ui/Button";

export type StatusFailedPage = {
  id: string;
  name: string;
  error?: string;
};

export type StatusJobHistoryEntry = Pick<
  JobState,
  "id" | "kind" | "status" | "progressText" | "detail" | "pageTotal"
>;

export function StatusPopover({
  id,
  jobState,
  progressSnapshot,
  showProgressBar,
  statusLines,
  onCancelJob,
  onClear,
  onClose,
  onOpenExport,
  onOpenLogFolder,
  onRetryPage,
  onReviewResults,
  failedPages = [],
  jobHistory = [],
}: {
  id: string;
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
  statusLines: string[];
  onCancelJob: () => void;
  onClear: () => void;
  onClose: () => void;
  onOpenExport?: () => void;
  onOpenLogFolder?: () => void;
  onRetryPage?: (pageId: string) => void;
  onReviewResults?: () => void;
  failedPages?: StatusFailedPage[];
  jobHistory?: StatusJobHistoryEntry[];
}): React.JSX.Element {
  const titleId = React.useId();
  const jobActive =
    jobState.status === "starting" ||
    jobState.status === "running" ||
    jobState.status === "cancelling";
  return (
    <section
      id={id}
      className="status-popover"
      aria-labelledby={titleId}
      role="region"
    >
      <StatusPopoverHeader
        titleId={titleId}
        statusCount={statusLines.length}
        historyCount={jobHistory.length}
        onClear={onClear}
        onClose={onClose}
        onOpenLogFolder={onOpenLogFolder}
      />
      <div className={`job-pill ${jobState.status}`} role="status">
        {jobState.progressText}
      </div>
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
      <FailedPageList pages={failedPages} onRetryPage={onRetryPage} />
      <StatusJobHistory entries={jobHistory} />
      <StatusPopoverLog lines={statusLines} />
    </section>
  );
}

function StatusPopoverHeader({
  titleId,
  statusCount,
  historyCount,
  onClear,
  onClose,
  onOpenLogFolder,
}: {
  titleId: string;
  statusCount: number;
  historyCount: number;
  onClear: () => void;
  onClose: () => void;
  onOpenLogFolder?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header>
      <div>
        <h2 id={titleId}>{t("statusDock.title")}</h2>
        <span>{t("statusDock.recentCount", { count: statusCount })}</span>
      </div>
      <div className="status-popover-actions">
        {onOpenLogFolder ? (
          <IconButton
            size="sm"
            label={t("statusDock.openLogs")}
            title={t("statusDock.openLogs")}
            onClick={onOpenLogFolder}
          >
            <IconFolderOpen size={15} aria-hidden="true" />
          </IconButton>
        ) : null}
        <IconButton
          size="sm"
          label={t("statusDock.clear")}
          title={t("statusDock.clear")}
          disabled={statusCount + historyCount === 0}
          onClick={onClear}
        >
          <IconTrash size={15} aria-hidden="true" />
        </IconButton>
        <IconButton
          size="sm"
          label={t("statusDock.close")}
          title={t("statusDock.close")}
          onClick={onClose}
        >
          <IconX size={16} aria-hidden="true" />
        </IconButton>
      </div>
    </header>
  );
}

function FailedPageList({
  onRetryPage,
  pages,
}: {
  onRetryPage?: (pageId: string) => void;
  pages: StatusFailedPage[];
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!pages.length) return null;
  return (
    <section
      className="status-failed-pages"
      aria-label={t("statusDock.failedPages")}
    >
      <header>
        <h3>{t("statusDock.failedPages")}</h3>
        <span>{pages.length}</span>
      </header>
      <ul>
        {pages.map((page) => (
          <li key={page.id}>
            <div>
              <strong>{page.name}</strong>
              {page.error ? <small>{page.error}</small> : null}
            </div>
            {onRetryPage ? (
              <Button
                size="sm"
                iconLeft={<IconRefresh size={14} aria-hidden="true" />}
                onClick={() => onRetryPage(page.id)}
              >
                {t("statusDock.retryPage")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusJobHistory({
  entries,
}: {
  entries: StatusJobHistoryEntry[];
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!entries.length) return null;
  return (
    <section
      className="status-job-history"
      aria-label={t("statusDock.recentJobs")}
    >
      <h3>{t("statusDock.recentJobs")}</h3>
      <ul>
        {entries.map((entry) => (
          <li key={`${entry.id}-${entry.status}`}>
            <span
              className={`status-history-mark ${entry.status}`}
              aria-hidden="true"
            />
            <span>
              <strong>{entry.progressText}</strong>
              {entry.pageTotal ? (
                <small>
                  {t("statusDock.completedPages", { count: entry.pageTotal })}
                </small>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusPopoverLog({ lines }: { lines: string[] }): React.JSX.Element {
  const { t } = useTranslation("components");
  const scrollable = lines.length > 5;
  return (
    <section
      className="status-log-section"
      aria-label={t("statusDock.statusHistory")}
    >
      <div className="status-log-section-heading">
        <h3>{t("statusDock.statusHistory")}</h3>
      </div>
      <div
        className={`status-popover-log ${scrollable ? "scrollable" : ""}`}
        role="log"
        aria-live="off"
        data-visible-limit="5"
      >
        {lines.length > 0 ? (
          lines.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)
        ) : (
          <p className="muted-line">{t("status.empty")}</p>
        )}
      </div>
    </section>
  );
}
