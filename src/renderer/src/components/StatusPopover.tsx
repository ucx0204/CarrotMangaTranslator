import React from "react";
import {
  IconBug,
  IconRefresh,
  IconTrash,
  IconVolume,
  IconVolume2,
  IconVolumeOff,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import type { CompletionSoundPreferences } from "../hooks/useCompletionSound";
import { RunJobFeedback } from "./RunStatusFeedback";
import { JobCancelButton } from "./RunStatusPanels";
import { IconButton } from "./ui/IconButton";
import { Button } from "./ui/Button";

const STATUS_LOG_BATCH_SIZE = 16;
const STATUS_LOG_BOTTOM_THRESHOLD_PX = 8;

export type StatusFailedPage = {
  id: string;
  name: string;
  error?: string;
};

export type StatusJobHistoryEntry = Pick<
  JobState,
  "id" | "kind" | "status" | "progressText" | "detail" | "pageTotal"
>;

type StatusPopoverProps = {
  id: string;
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
  statusLines: string[];
  completionSoundMuted: boolean;
  completionSoundVolume: number;
  onCancelJob: () => void;
  onClear: () => void;
  onCompletionSoundChange: (preferences: CompletionSoundPreferences) => void;
  onClose: () => void;
  onOpenExport?: () => void;
  onOpenErrorReport?: () => void;
  onRetryPage?: (pageId: string) => void;
  onReviewResults?: () => void;
  failedPages?: StatusFailedPage[];
  jobHistory?: StatusJobHistoryEntry[];
};

export function StatusPopover({
  id,
  jobState,
  progressSnapshot,
  showProgressBar,
  statusLines,
  completionSoundMuted,
  completionSoundVolume,
  onCancelJob,
  onClear,
  onCompletionSoundChange,
  onClose,
  onOpenExport,
  onOpenErrorReport,
  onRetryPage,
  onReviewResults,
  failedPages = [],
  jobHistory = [],
}: StatusPopoverProps): React.JSX.Element {
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
        completionSoundMuted={completionSoundMuted}
        completionSoundVolume={completionSoundVolume}
        onClear={onClear}
        onCompletionSoundChange={onCompletionSoundChange}
        onClose={onClose}
        onOpenErrorReport={onOpenErrorReport}
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
  completionSoundMuted,
  completionSoundVolume,
  onClear,
  onCompletionSoundChange,
  onClose,
  onOpenErrorReport,
}: {
  titleId: string;
  statusCount: number;
  historyCount: number;
  completionSoundMuted: boolean;
  completionSoundVolume: number;
  onClear: () => void;
  onCompletionSoundChange: (preferences: CompletionSoundPreferences) => void;
  onClose: () => void;
  onOpenErrorReport?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header>
      <div>
        <h2 id={titleId}>{t("statusDock.title")}</h2>
        <span>{t("statusDock.recentCount", { count: statusCount })}</span>
      </div>
      <div className="status-popover-actions">
        <CompletionSoundControl
          muted={completionSoundMuted}
          volume={completionSoundVolume}
          onChange={onCompletionSoundChange}
        />
        {onOpenErrorReport ? (
          <IconButton
            size="sm"
            label={t("statusDock.reportProblem")}
            title={t("statusDock.reportProblem")}
            onClick={onOpenErrorReport}
          >
            <IconBug size={15} aria-hidden="true" />
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

function CompletionSoundControl({
  muted,
  volume,
  onChange,
}: {
  muted: boolean;
  volume: number;
  onChange: (preferences: CompletionSoundPreferences) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const normalizedVolume = Math.min(1, Math.max(0, volume));
  const percent = Math.round(normalizedVolume * 100);
  const VolumeIcon = muted
    ? IconVolumeOff
    : percent < 50
      ? IconVolume
      : IconVolume2;
  const volumeLabel = t("statusDock.completionSoundVolume");
  const muteLabel = t(
    muted
      ? "statusDock.unmuteCompletionSound"
      : "statusDock.muteCompletionSound",
  );
  return (
    <div className={`status-sound-control${muted ? " muted" : ""}`}>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        aria-label={volumeLabel}
        aria-valuetext={`${percent}%`}
        title={`${volumeLabel}: ${percent}%`}
        style={
          {
            "--status-sound-progress": `${percent}%`,
          } as React.CSSProperties
        }
        onChange={(event) =>
          onChange({
            muted,
            volume: Number(event.currentTarget.value) / 100,
          })
        }
      />
      <IconButton
        size="sm"
        aria-pressed={muted}
        label={muteLabel}
        title={muteLabel}
        onClick={() => onChange({ muted: !muted, volume: normalizedVolume })}
      >
        <VolumeIcon size={16} aria-hidden="true" />
      </IconButton>
    </div>
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
  const [visibleCount, setVisibleCount] = React.useState(STATUS_LOG_BATCH_SIZE);
  React.useEffect(() => {
    if (lines.length === 0) {
      setVisibleCount(STATUS_LOG_BATCH_SIZE);
    }
  }, [lines.length]);
  const visibleLines = lines.slice(0, visibleCount);
  const hasOlderLines = visibleCount < lines.length;
  const scrollable = visibleLines.length > 5;
  const loadOlderLinesAtBottom = (event: React.UIEvent<HTMLDivElement>) => {
    const log = event.currentTarget;
    const distanceFromBottom =
      log.scrollHeight - log.scrollTop - log.clientHeight;
    if (!hasOlderLines || distanceFromBottom > STATUS_LOG_BOTTOM_THRESHOLD_PX) {
      return;
    }
    setVisibleCount((current) =>
      Math.min(lines.length, current + STATUS_LOG_BATCH_SIZE),
    );
  };
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
        data-loaded-count={visibleLines.length}
        onScroll={loadOlderLinesAtBottom}
      >
        {visibleLines.length > 0 ? (
          visibleLines.map((line, index) => (
            <p key={`${line}-${index}`}>{line}</p>
          ))
        ) : (
          <p className="muted-line">{t("status.empty")}</p>
        )}
      </div>
    </section>
  );
}
