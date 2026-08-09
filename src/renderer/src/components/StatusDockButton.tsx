import React from "react";
import { IconBell } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { IconButton } from "./ui/IconButton";
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
  onCancelJob: () => void;
  onClear: () => void;
  onOpenExport?: () => void;
  onOpenLogFolder?: () => void;
  onRetryPage?: (pageId: string) => void;
  onReviewResults?: () => void;
  failedPages?: StatusFailedPage[];
};

export function StatusDockButton({
  jobState,
  progressSnapshot,
  showProgressBar,
  statusLines,
  onCancelJob,
  onClear,
  onOpenExport,
  onOpenLogFolder,
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
          onClose={() => closePopover(true)}
          onOpenExport={resultActions.onOpenExport}
          onOpenLogFolder={onOpenLogFolder}
          onRetryPage={resultActions.onRetryPage}
          onReviewResults={resultActions.onReviewResults}
        />
      ) : null}
    </div>
  );
}

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
      isTerminalJob(previous) &&
      (previous.id !== jobState.id || !isTerminalJob(jobState))
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

function isTerminalJob(jobState: JobState): boolean {
  return ["completed", "partial", "failed", "cancelled"].includes(
    jobState.status,
  );
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
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const previousLatestRef = React.useRef<string | undefined>(undefined);
  const [open, setOpen] = React.useState(false);
  const [unread, setUnread] = React.useState(false);
  const closePopover = React.useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  React.useEffect(() => {
    if (latest && latest !== previousLatestRef.current && !open) {
      setUnread(true);
    }
    previousLatestRef.current = latest;
  }, [latest, open]);
  React.useEffect(() => {
    if (open) setUnread(false);
  }, [open]);
  useStatusPopoverDismiss(open, rootRef, closePopover);
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

function useStatusPopoverDismiss(
  open: boolean,
  rootRef: React.RefObject<HTMLDivElement | null>,
  close: (restoreFocus?: boolean) => void,
): void {
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open, rootRef]);
}
