import React from "react";
import { IconBell } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import { isTerminalJobStatus } from "../../../shared/jobContracts";
import type { ProgressSnapshot } from "../lib/jobProgress";
import type { CompletionSoundPreferences } from "../hooks/useCompletionSound";
import type { AppOperationActivityEvent } from "../../../shared/appOperationTypes";
import {
  formatAppOperationActivity,
  isAppOperationActive,
} from "../lib/appOperationPresentation";
import { IconButton } from "./ui/IconButton";
import { usePopupController } from "./ui/usePopupController";
import { StatusPopover, type StatusFailedPage } from "./StatusPopover";
import {
  clearStatusCenterHistory,
  loadStatusCenterHistory,
  saveStatusCenterHistory,
  STATUS_CENTER_HISTORY_LIMIT,
  type StatusCenterHistoryEntry,
} from "../lib/statusCenterHistoryStore";
import { OPEN_STATUS_CENTER_EVENT } from "../lib/statusCenterEvents";
import type { StatusLogEntry } from "../hooks/useStatusLog";

type StatusDockButtonProps = {
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
  statusEntries?: StatusLogEntry[];
  statusLines: string[];
  completionSoundMuted?: boolean;
  completionSoundVolume?: number;
  completionSoundTranslationMuted?: boolean;
  completionSoundSoundEffectMuted?: boolean;
  completionSoundSourceErasingMuted?: boolean;
  completionSoundResearchMuted?: boolean;
  onCancelJob: () => void;
  operationActivity?: AppOperationActivityEvent | null;
  onCancelOperation?: () => void;
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
  statusEntries,
  statusLines,
  completionSoundMuted = true,
  completionSoundVolume = 0.55,
  completionSoundTranslationMuted,
  completionSoundSoundEffectMuted,
  completionSoundSourceErasingMuted,
  completionSoundResearchMuted,
  onCancelJob,
  operationActivity = null,
  onCancelOperation,
  onClear,
  onCompletionSoundChange = NOOP_COMPLETION_SOUND_CHANGE,
  onOpenExport,
  onOpenErrorReport,
  onRetryPage,
  onReviewResults,
  failedPages = [],
}: StatusDockButtonProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const { t: rendererT } = useTranslation("renderer");
  const popoverId = React.useId();
  const operationLine = resolveActiveOperationLine(
    operationActivity,
    rendererT,
  );
  const resolvedStatusEntries =
    statusEntries ?? statusLines.map((message) => ({ message }));
  const visibleStatusEntries = removeCurrentStatusEntry(
    resolvedStatusEntries,
    operationLine ?? resolveActiveJobLine(jobState),
  );
  const latest = resolveLatestStatusLine(operationLine, resolvedStatusEntries);
  const {
    closePopover,
    open,
    rootRef,
    setOpen,
    setUnread,
    triggerRef,
    unread,
  } = useStatusDockController(latest);
  const jobHistory = useStatusJobHistory(
    jobState,
    operationActivity,
    rendererT,
  );
  const resultActions = createStatusResultActions({
    onOpenExport,
    onReviewResults,
    onRetryPage,
    setOpen,
  });

  const indicator = resolveStatusIndicator(jobState, operationActivity, unread);
  const tooltip = resolveStatusTooltip(latest, t);
  return (
    <div className="status-dock" ref={rootRef}>
      <IconButton
        ref={triggerRef}
        data-work-center-handoff-target=""
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
          completionSoundTranslationMuted={Boolean(
            completionSoundTranslationMuted,
          )}
          completionSoundSoundEffectMuted={Boolean(
            completionSoundSoundEffectMuted,
          )}
          completionSoundSourceErasingMuted={Boolean(
            completionSoundSourceErasingMuted,
          )}
          completionSoundResearchMuted={Boolean(completionSoundResearchMuted)}
          id={popoverId}
          jobState={jobState}
          operationActivity={
            isAppOperationActive(operationActivity) ? operationActivity : null
          }
          progressSnapshot={progressSnapshot}
          showProgressBar={showProgressBar}
          statusEntries={visibleStatusEntries}
          failedPages={failedPages}
          jobHistory={resolveVisibleHistory(jobHistory.entries, jobState)}
          onCancelJob={onCancelJob}
          onCancelOperation={onCancelOperation}
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

function resolveVisibleHistory(
  entries: StatusCenterHistoryEntry[],
  jobState: JobState,
): StatusCenterHistoryEntry[] {
  return isTerminalJobStatus(jobState.status)
    ? entries.filter((entry) => entry.id !== jobState.id)
    : entries;
}

function resolveActiveOperationLine(
  activity: AppOperationActivityEvent | null,
  t: TFunction<"renderer">,
): string | undefined {
  return activity && isAppOperationActive(activity)
    ? formatAppOperationActivity(activity, t)
    : undefined;
}

function resolveLatestStatusLine(
  operationLine: string | undefined,
  statusEntries: readonly StatusLogEntry[],
): string | undefined {
  return operationLine ?? statusEntries[0]?.message;
}

function resolveActiveJobLine(jobState: JobState): string | undefined {
  return ["starting", "running", "cancelling"].includes(jobState.status)
    ? jobState.progressText
    : undefined;
}

function removeCurrentStatusEntry(
  statusEntries: readonly StatusLogEntry[],
  currentLine: string | undefined,
): StatusLogEntry[] {
  const normalizedCurrent = currentLine?.trim();
  if (!normalizedCurrent) return [...statusEntries];
  const currentIndex = statusEntries.findIndex(
    (entry) => entry.message.trim() === normalizedCurrent,
  );
  if (currentIndex < 0) return [...statusEntries];
  return statusEntries.filter((_, index) => index !== currentIndex);
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
  closeAfter: (action?: () => void) => (() => void) | undefined;
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
    closeAfter,
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

function useStatusJobHistory(
  jobState: JobState,
  operationActivity: AppOperationActivityEvent | null,
  rendererT: TFunction<"renderer">,
): {
  clear: () => void;
  entries: StatusCenterHistoryEntry[];
} {
  const jobTerminalRef = React.useRef<string | null>(null);
  const operationTerminalRef = React.useRef<string | null>(null);
  const [entries, setEntries] = React.useState<StatusCenterHistoryEntry[]>(
    loadStatusCenterHistory,
  );
  React.useEffect(() => {
    if (!isTerminalJobStatus(jobState.status)) return;
    const terminalKey = `${jobState.id}:${jobState.status}`;
    if (jobTerminalRef.current === terminalKey) return;
    jobTerminalRef.current = terminalKey;
    setEntries((current) => prependHistory(current, toHistoryEntry(jobState)));
  }, [jobState]);
  React.useEffect(() => {
    if (!operationActivity || isAppOperationActive(operationActivity)) return;
    const terminalKey = `${operationActivity.id}:${operationActivity.updatedAt}`;
    if (operationTerminalRef.current === terminalKey) return;
    operationTerminalRef.current = terminalKey;
    setEntries((current) => {
      const next = current.filter((entry) => entry.id !== operationActivity.id);
      const terminalEntry: StatusCenterHistoryEntry = {
        id: operationActivity.id,
        source: "operation",
        kind: operationActivity.kind,
        status: operationActivity.status,
        completedAt: operationActivity.updatedAt,
        ...(operationActivity.failureCode
          ? { failureCode: operationActivity.failureCode }
          : {}),
        ...(operationActivity.phase ? { phase: operationActivity.phase } : {}),
        ...(operationActivity.sourceKind
          ? { sourceKind: operationActivity.sourceKind }
          : {}),
        progressText: formatAppOperationActivity(operationActivity, rendererT),
      };
      return [terminalEntry, ...next].slice(0, STATUS_CENTER_HISTORY_LIMIT);
    });
  }, [operationActivity, rendererT]);
  React.useEffect(() => saveStatusCenterHistory(entries), [entries]);
  return {
    clear: React.useCallback(() => {
      setEntries([]);
      clearStatusCenterHistory();
    }, []),
    entries,
  };
}

function toHistoryEntry(jobState: JobState): StatusCenterHistoryEntry {
  return {
    id: jobState.id,
    source: "job",
    kind: jobState.kind,
    status: jobState.status,
    completedAt: Date.now(),
    progressText: jobState.progressText,
    pageTotal: jobState.pageTotal ?? jobState.progressTotal,
  };
}

function prependHistory(
  current: StatusCenterHistoryEntry[],
  entry: StatusCenterHistoryEntry,
): StatusCenterHistoryEntry[] {
  return [entry, ...current.filter((item) => item.id !== entry.id)].slice(
    0,
    STATUS_CENTER_HISTORY_LIMIT,
  );
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
    isInsidePopup: isStatusSoundPopoverTarget,
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
  React.useEffect(() => {
    const openStatusCenter = (): void => setOpen(true);
    window.addEventListener(OPEN_STATUS_CENTER_EVENT, openStatusCenter);
    return () =>
      window.removeEventListener(OPEN_STATUS_CENTER_EVENT, openStatusCenter);
  }, []);
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

function isStatusSoundPopoverTarget(target: Node): boolean {
  const element = target instanceof Element ? target : target.parentElement;
  return Boolean(element?.closest(".status-sound-popover"));
}

function resolveStatusIndicator(
  jobState: JobState,
  operationActivity: AppOperationActivityEvent | null,
  unread: boolean,
): string {
  if (
    jobState.status === "starting" ||
    jobState.status === "running" ||
    jobState.status === "cancelling"
  ) {
    return "running";
  }
  if (isAppOperationActive(operationActivity)) return "running";
  if (jobState.status === "failed") return "failed";
  if (jobState.status === "partial") return "partial";
  if (operationActivity?.status === "failed") return "failed";
  return unread ? "unread" : "idle";
}
