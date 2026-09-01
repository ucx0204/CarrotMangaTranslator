import React from "react";
import { IconBug, IconRefresh, IconTrash, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import type { CompletionSoundPreferences } from "../hooks/useCompletionSound";
import { IconButton } from "./ui/IconButton";
import { Button } from "./ui/Button";
import type { AppOperationActivityEvent } from "../../../shared/appOperationTypes";
import type { StatusCenterHistoryEntry } from "../lib/statusCenterHistoryStore";
import { CurrentStatusContent, StatusJobHistory } from "./StatusPopoverDetails";
import { CompletionSoundControl } from "./CompletionSoundControl";
import type { StatusLogContext, StatusLogEntry } from "../hooks/useStatusLog";
import { ControlTooltip } from "./ui/ControlTooltip";

const STATUS_LOG_BATCH_SIZE = 16;
const STATUS_LOG_BOTTOM_THRESHOLD_PX = 8;

export type StatusFailedPage = {
  id: string;
  name: string;
  error?: string;
};

type StatusPopoverProps = {
  id: string;
  jobState: JobState;
  operationActivity?: AppOperationActivityEvent | null;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
  statusEntries: StatusLogEntry[];
  completionSoundMuted: boolean;
  completionSoundVolume: number;
  completionSoundTranslationMuted: boolean;
  completionSoundSoundEffectMuted: boolean;
  completionSoundSourceErasingMuted: boolean;
  completionSoundResearchMuted: boolean;
  onCancelJob: () => void;
  onCancelOperation?: () => void;
  onClear: () => void;
  onCompletionSoundChange: (preferences: CompletionSoundPreferences) => void;
  onClose: () => void;
  onOpenExport?: () => void;
  onOpenErrorReport?: () => void;
  onRetryPage?: (pageId: string) => void;
  onReviewResults?: () => void;
  failedPages?: StatusFailedPage[];
  jobHistory?: StatusCenterHistoryEntry[];
};

export function StatusPopover({
  id,
  jobState,
  operationActivity = null,
  progressSnapshot,
  showProgressBar,
  statusEntries,
  completionSoundMuted,
  completionSoundVolume,
  completionSoundTranslationMuted,
  completionSoundSoundEffectMuted,
  completionSoundSourceErasingMuted,
  completionSoundResearchMuted,
  onCancelJob,
  onCancelOperation,
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
  const soundPreferences = {
    muted: completionSoundMuted,
    volume: completionSoundVolume,
    translationMuted: completionSoundTranslationMuted,
    soundEffectMuted: completionSoundSoundEffectMuted,
    sourceErasingMuted: completionSoundSourceErasingMuted,
    researchMuted: completionSoundResearchMuted,
  };
  return (
    <section
      id={id}
      className="status-popover"
      aria-labelledby={titleId}
      role="region"
    >
      <StatusPopoverHeader
        titleId={titleId}
        statusCount={statusEntries.length}
        historyCount={jobHistory.length}
        soundPreferences={soundPreferences}
        onClear={onClear}
        onCompletionSoundChange={onCompletionSoundChange}
        onClose={onClose}
        onOpenErrorReport={onOpenErrorReport}
      />
      <CurrentStatusContent
        jobState={jobState}
        operationActivity={operationActivity}
        progressSnapshot={progressSnapshot}
        showProgressBar={showProgressBar}
        onCancelJob={onCancelJob}
        onCancelOperation={onCancelOperation}
        onOpenExport={onOpenExport}
        onReviewResults={onReviewResults}
      />
      <FailedPageList pages={failedPages} onRetryPage={onRetryPage} />
      <StatusJobHistory entries={jobHistory} />
      <StatusPopoverLog
        entries={isDedicatedResearchProgress(jobState) ? [] : statusEntries}
      />
    </section>
  );
}

function isDedicatedResearchProgress(jobState: JobState): boolean {
  return (
    jobState.kind === "internet-research" &&
    Boolean(jobState.research) &&
    ["starting", "running", "cancelling"].includes(jobState.status)
  );
}

function StatusPopoverHeader({
  titleId,
  statusCount,
  historyCount,
  soundPreferences,
  onClear,
  onCompletionSoundChange,
  onClose,
  onOpenErrorReport,
}: {
  titleId: string;
  statusCount: number;
  historyCount: number;
  soundPreferences: Required<CompletionSoundPreferences>;
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
          preferences={soundPreferences}
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

function StatusPopoverLog({
  entries,
}: {
  entries: StatusLogEntry[];
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const [visibleCount, setVisibleCount] = React.useState(STATUS_LOG_BATCH_SIZE);
  React.useEffect(() => {
    if (entries.length === 0) {
      setVisibleCount(STATUS_LOG_BATCH_SIZE);
    }
  }, [entries.length]);
  if (entries.length === 0) return null;
  const visibleEntries = entries.slice(0, visibleCount);
  const hasOlderLines = visibleCount < entries.length;
  const scrollable = visibleEntries.length > 5;
  const loadOlderLinesAtBottom = (event: React.UIEvent<HTMLDivElement>) => {
    const log = event.currentTarget;
    const distanceFromBottom =
      log.scrollHeight - log.scrollTop - log.clientHeight;
    if (!hasOlderLines || distanceFromBottom > STATUS_LOG_BOTTOM_THRESHOLD_PX) {
      return;
    }
    setVisibleCount((current) =>
      Math.min(entries.length, current + STATUS_LOG_BATCH_SIZE),
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
        data-loaded-count={visibleEntries.length}
        onScroll={loadOlderLinesAtBottom}
      >
        {visibleEntries.map((entry, index) => (
          <p
            key={`${entry.message}-${entry.context?.chapterId ?? "global"}-${index}`}
          >
            <span className="status-log-message">{entry.message}</span>
            <StatusLogContextLabel context={entry.context} />
          </p>
        ))}
      </div>
    </section>
  );
}

function StatusLogContextLabel({
  context,
}: {
  context?: StatusLogContext;
}): React.JSX.Element | null {
  if (!context) return null;
  const label = `· ${context.chapterTitle}`;
  if (!context.workTitle) {
    return <span className="status-log-context-label">{label}</span>;
  }
  return (
    <ControlTooltip
      className="status-log-context-tooltip"
      content={context.workTitle}
      placement="left"
    >
      <span className="status-log-context-label" tabIndex={0}>
        {label}
      </span>
    </ControlTooltip>
  );
}
