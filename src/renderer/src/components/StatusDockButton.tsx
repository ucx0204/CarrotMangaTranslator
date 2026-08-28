import React from "react";
import { IconBell } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import { isTerminalJobStatus } from "../../../shared/jobContracts";
import type { ProgressSnapshot } from "../lib/jobProgress";
import type { CompletionSoundPreferences } from "../hooks/useCompletionSound";
import { IconButton } from "./ui/IconButton";
import { usePopupController } from "./ui/usePopupController";
import {
  StatusPopover,
  type StatusFailedPage,
  type StatusJobHistoryEntry,
} from "./StatusPopover";

type StatusDockButtonProps = {
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
  statusLines: string[];
  completionSoundMuted?: boolean;
  completionSoundVolume?: number;
  onCancelJob: () => void;
  onClear: () => void;
  onCompletionSoundChange?: (preferences: CompletionSoundPreferences) => void;
  onOpenExport?: () => void;
  onOpenErrorReport?: () => void;
  onRetryPage?: (pageId: string) => void;
  onReviewResults?: () => void;
  failedPages?: StatusFailedPage[];
};

// eslint-disable-next-line max-lines-per-function -- popup focus, unread state, completion controls, and result actions share one dock lifecycle
export function StatusDockButton({
  jobState,
  progressSnapshot,
  showProgressBar,
  statusLines,
  completionSoundMuted = true,
  completionSoundVolume = 0.55,
  onCancelJob,
  onClear,
  onCompletionSoundChange = NOOP_COMPLETION_SOUND_CHANGE,
  onOpenExport,
  onOpenErrorReport,
  onRetryPage,
  onReviewResults,
  failedPages = [],
}: StatusDockButtonProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const popoverId = React.useId();
  const latest = statusLines[0];
  const {
    closePopover,
    open,
    rootRef,
    setOpen,
    setUnread,
    triggerRef,
    unread,
  } = useStatusDockController(latest);
  const jobHistory = useStatusJobHistory(jobState);
  const resultActions = createStatusResultActions({
    onOpenExport,
    onReviewResults,
    onRetryPage,
    setOpen,
  });

  const indicator = resolveStatusIndicator(jobState, unread);
  const tooltip = resolveStatusTooltip(latest, t);
  return (
    <div className="status-dock" ref={rootRef}>
      <IconButton
        ref={triggerRef}
        className={`status-dock-button ${indicator}`}
        label={t("statusDock.open")}
        title={tooltip}
        aria-controls={popoverId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="status-dock-bell" aria-hidden="true">
          <IconBell size={18} />
        </span>
        <span className="status-dock-indicator" aria-hidden="true" />
      </IconButton>
      <span className="visually-hidden" role="status" aria-live="polite">
        {latest ?? jobState.progressText}
      </span>
      {open ? (
        <StatusPopover
          completionSoundMuted={completionSoundMuted}
          completionSoundVolume={completionSoundVolume}
          id={popoverId}
          jobState={jobState}
          progressSnapshot={progressSnapshot}
          showProgressBar={showProgressBar}
          statusLines={statusLines}
          failedPages={failedPages}
          jobHistory={jobHistory.entries}
          onCancelJob={onCancelJob}
          onClear={() => {
            onClear();
            jobHistory.clear();
            setUnread(false);
          }}
          onCompletionSoundChange={onCompletionSoundChange}
          onClose={() => closePopover(true)}
          onOpenExport={resultActions.onOpenExport}
          onOpenErrorReport={onOpenErrorReport}
          onRetryPage={resultActions.onRetryPage}
          onReviewResults={resultActions.onReviewResults}
        />
      ) : null}
    </div>
  );
}

const NOOP_COMPLETION_SOUND_CHANGE = (
  _preferences: CompletionSoundPreferences,
): void => undefined;

function resolveStatusTooltip(
  latest: string | undefined,
  t: TFunction<"components">,
): string {
  return latest
    ? t("statusDock.latest", { line: latest })
    : t("statusDock.open");
}

function createStatusResultActions({
  onOpenExport,
  onReviewResults,
  onRetryPage,
  setOpen,
}: {
  onOpenExport?: () => void;
  onReviewResults?: () => void;
  onRetryPage?: (pageId: string) => void;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}): {
  onOpenExport?: () => void;
  onReviewResults?: () => void;
  onRetryPage?: (pageId: string) => void;
} {
  const closeAfter = (action?: () => void): (() => void) | undefined =>
    action
      ? () => {
          action();
          setOpen(false);
        }
      : undefined;
  return {
    onOpenExport: closeAfter(onOpenExport),
    onReviewResults: closeAfter(onReviewResults),
    onRetryPage: onRetryPage
      ? (pageId) => {
          onRetryPage(pageId);
          setOpen(false);
        }
      : undefined,
  };
}

function useStatusJobHistory(jobState: JobState): {
  clear: () => void;
  entries: StatusJobHistoryEntry[];
} {
  const previousRef = React.useRef<JobState | null>(null);
  const [entries, setEntries] = React.useState<StatusJobHistoryEntry[]>([]);
  React.useEffect(() => {
    const previous = previousRef.current;
    if (
      previous &&
      isTerminalJobStatus(previous.status) &&
      (previous.id !== jobState.id || !isTerminalJobStatus(jobState.status))
    ) {
      setEntries((current) => {
        if (current.some((entry) => entry.id === previous.id)) return current;
        return [toHistoryEntry(previous), ...current].slice(0, 5);
      });
    }
    previousRef.current = jobState;
  }, [jobState]);
  return {
    clear: React.useCallback(() => setEntries([]), []),
    entries,
  };
}

function toHistoryEntry(jobState: JobState): StatusJobHistoryEntry {
  return {
    id: jobState.id,
    kind: jobState.kind,
    status: jobState.status,
    progressText: jobState.progressText,
    detail: jobState.detail,
    pageTotal: jobState.pageTotal ?? jobState.progressTotal,
  };
}

function useStatusDockController(latest: string | undefined) {
  const previousLatestRef = React.useRef<string | undefined>(undefined);
  const [open, setOpen] = React.useState(false);
  const [unread, setUnread] = React.useState(false);
  const {
    close: closePopover,
    rootRef,
    triggerRef,
  } = usePopupController({
    initialFocus: false,
    open,
    onOpenChange: setOpen,
  });

  React.useEffect(() => {
    if (latest && latest !== previousLatestRef.current && !open) {
      setUnread(true);
    }
    previousLatestRef.current = latest;
  }, [latest, open]);
  React.useEffect(() => {
    if (open) setUnread(false);
  }, [open]);
  return {
    closePopover,
    open,
    rootRef,
    setOpen,
    setUnread,
    triggerRef,
    unread,
  };
}

function resolveStatusIndicator(jobState: JobState, unread: boolean): string {
  if (jobState.status === "failed") return "failed";
  if (jobState.status === "partial") return "partial";
  if (
    jobState.status === "starting" ||
    jobState.status === "running" ||
    jobState.status === "cancelling"
  ) {
    return "running";
  }
  return unread ? "unread" : "idle";
}
