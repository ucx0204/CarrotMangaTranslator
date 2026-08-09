import React from "react";
import { IconTrash, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { RunJobFeedback } from "./RunStatusFeedback";
import { JobCancelButton } from "./RunStatusPanels";
import { IconButton } from "./ui/IconButton";

export function StatusPopover({
  id,
  jobState,
  progressSnapshot,
  showProgressBar,
  statusLines,
  onCancelJob,
  onClear,
  onClose,
}: {
  id: string;
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
  statusLines: string[];
  onCancelJob: () => void;
  onClear: () => void;
  onClose: () => void;
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
        onClear={onClear}
        onClose={onClose}
      />
      <div className={`job-pill ${jobState.status}`} role="status">
        {jobState.progressText}
      </div>
      <RunJobFeedback
        jobState={jobState}
        progressSnapshot={progressSnapshot}
        showProgressBar={showProgressBar}
      />
      {jobActive ? (
        <JobCancelButton
          cancelling={jobState.status === "cancelling"}
          onCancel={onCancelJob}
        />
      ) : null}
      <StatusPopoverLog lines={statusLines} />
    </section>
  );
}

function StatusPopoverHeader({
  titleId,
  statusCount,
  onClear,
  onClose,
}: {
  titleId: string;
  statusCount: number;
  onClear: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header>
      <div>
        <h2 id={titleId}>{t("statusDock.title")}</h2>
        <span>{t("statusDock.recentCount", { count: statusCount })}</span>
      </div>
      <div className="status-popover-actions">
        <IconButton
          size="sm"
          label={t("statusDock.clear")}
          title={t("statusDock.clear")}
          disabled={statusCount === 0}
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

function StatusPopoverLog({ lines }: { lines: string[] }): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="status-popover-log" role="log" aria-live="off">
      {lines.length > 0 ? (
        lines.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)
      ) : (
        <p className="muted-line">{t("status.empty")}</p>
      )}
    </div>
  );
}
