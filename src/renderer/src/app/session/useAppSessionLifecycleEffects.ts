import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type { JobState } from "../../../../shared/jobTypes";
import { isTerminalJobStatus } from "../../../../shared/jobContracts";
import type { ErrorReportContext } from "../../../../shared/errorReportTypes";
import type { RegionSelectionState } from "../../lib/appHelpers";
import { toast } from "../../lib/toastStore";
import { formatJobLabel } from "../../lib/jobProgress";
import { useEventCallback } from "../../hooks/useEventCallback";
import type { CompletionSoundCategory } from "../../hooks/useCompletionSound";

type OpenErrorReport = (
  context: ErrorReportContext,
  options?: { force?: boolean },
) => unknown;

type UseAppSessionLifecycleEffectsArgs = {
  currentChapter: ChapterSnapshot | null;
  jobState: JobState;
  onAudibleCompletion?: (category: CompletionSoundCategory) => void;
  onJobStart: () => void;
  onPageChange: () => void;
  openErrorReport: OpenErrorReport;
  refreshLibrary: () => void | Promise<void>;
  resetChapterScopedUi: () => void;
  selectedPageId: string | null;
  setRegionSelection: Dispatch<SetStateAction<RegionSelectionState | null>>;
  translationFlowActive: boolean;
};

export function useAppSessionLifecycleEffects({
  currentChapter,
  jobState,
  onAudibleCompletion,
  onJobStart,
  onPageChange,
  openErrorReport,
  refreshLibrary,
  resetChapterScopedUi,
  selectedPageId,
  setRegionSelection,
  translationFlowActive,
}: UseAppSessionLifecycleEffectsArgs): void {
  const { t } = useTranslation("renderer");
  const prevJobStatusRef = useRef<JobState["status"]>("idle");
  const prevFlowActiveRef = useRef(translationFlowActive);
  const reportedJobIdRef = useRef<string | null>(null);
  const previousPageIdRef = useRef(selectedPageId);
  const refreshLibraryState = useEventCallback(() => {
    void refreshLibrary();
  });
  const notifyPageChange = useEventCallback(onPageChange);
  const resetCurrentChapterUi = useEventCallback(resetChapterScopedUi);
  const notifyJobStatusChange = useEventCallback(() => {
    handleJobStatusChange({
      jobState,
      onAudibleCompletion,
      onJobStart,
      openErrorReport,
      reportedJobIdRef,
      t,
      translationFlowActive,
    });
  });
  const currentChapterId = currentChapter?.id ?? null;
  const jobStatus = jobState.status;

  useInitialLibraryRefresh(refreshLibraryState);

  useEffect(() => {
    setRegionSelection(null);
  }, [selectedPageId, setRegionSelection]);

  useEffect(() => {
    if (previousPageIdRef.current === selectedPageId) return;
    previousPageIdRef.current = selectedPageId;
    notifyPageChange();
  }, [notifyPageChange, selectedPageId]);

  useEffect(() => {
    if (!currentChapterId) {
      resetCurrentChapterUi();
    }
  }, [currentChapterId, resetCurrentChapterUi]);

  useEffect(() => {
    const previous = prevJobStatusRef.current;
    const next = jobStatus;
    const flowJustFinished =
      prevFlowActiveRef.current && !translationFlowActive;
    prevFlowActiveRef.current = translationFlowActive;
    if (
      isTerminalJobStatus(next) &&
      !translationFlowActive &&
      (previous !== next || flowJustFinished)
    ) {
      refreshLibraryState();
    }
    if (previous === next && !(flowJustFinished && isTerminalJobStatus(next))) {
      return;
    }
    prevJobStatusRef.current = next;
    notifyJobStatusChange();
  }, [
    jobStatus,
    notifyJobStatusChange,
    refreshLibraryState,
    translationFlowActive,
  ]);
}

function useInitialLibraryRefresh(refreshLibrary: () => void): void {
  const refreshStartedRef = useRef(false);
  useEffect(() => {
    if (refreshStartedRef.current) return;
    refreshStartedRef.current = true;
    refreshLibrary();
  }, [refreshLibrary]);
}

type JobStatusChangeArgs = {
  jobState: JobState;
  onAudibleCompletion?: (category: CompletionSoundCategory) => void;
  onJobStart: () => void;
  openErrorReport: OpenErrorReport;
  reportedJobIdRef: { current: string | null };
  t: TFunction<"renderer">;
  translationFlowActive: boolean;
};

function handleJobStatusChange({
  jobState,
  onAudibleCompletion,
  onJobStart,
  openErrorReport,
  reportedJobIdRef,
  t,
  translationFlowActive,
}: JobStatusChangeArgs): void {
  const next = jobState.status;
  if (next === "starting" || next === "running") {
    onJobStart();
    return;
  }
  if (translationFlowActive && isTerminalJobStatus(next)) return;
  if (next === "completed") {
    handleCompletedJob(jobState, onAudibleCompletion, t);
    return;
  }
  if (next === "partial") {
    toast.warn(formatJobLabel(jobState, t) || t("job.notifications.partial"));
    return;
  }
  if (next === "failed") {
    handleFailedJob({
      jobState,
      openErrorReport,
      reportedJobIdRef,
      t,
    });
    return;
  }
  if (next === "cancelled") {
    toast.info(t("job.notifications.cancelled"));
  }
}

function handleCompletedJob(
  jobState: JobState,
  onAudibleCompletion:
    | ((category: CompletionSoundCategory) => void)
    | undefined,
  t: TFunction<"renderer">,
): void {
  toast.success(
    formatJobLabel(jobState, t) || t("job.notifications.completed"),
  );
  const soundCategory = resolveCompletionSoundCategory(jobState);
  if (soundCategory) onAudibleCompletion?.(soundCategory);
}

function resolveCompletionSoundCategory(
  jobState: JobState,
): CompletionSoundCategory | null {
  if (jobState.kind === "sound-effect-translation") return "sound-effect";
  if (jobState.kind === "inpainting") return "source-erasing";
  if (jobState.kind === "internet-research") return "research";
  if (
    jobState.kind === "gemma-analysis" &&
    !jobState.id.startsWith("work-context-")
  ) {
    return "translation";
  }
  return null;
}

function handleFailedJob({
  jobState,
  openErrorReport,
  reportedJobIdRef,
  t,
}: Pick<
  JobStatusChangeArgs,
  "jobState" | "openErrorReport" | "reportedJobIdRef" | "t"
>): void {
  if (reportedJobIdRef.current === jobState.id) {
    return;
  }
  reportedJobIdRef.current = jobState.id;
  const summary = formatJobLabel(jobState, t) || t("job.notifications.failed");
  if (jobState.failureGuidance) {
    toast.error(summary);
    return;
  }
  const context = createFailedJobContext(jobState, summary);
  /*
   * A failed job already shows in the run status panel and the status log.
   * The toast is the interrupting surface, and its action is the way into the
   * report — opening the dialog unprompted would steal focus from whatever the
   * user moved on to while the job ran.
   */
  toast.error(summary, {
    action: {
      label: t("job.notifications.reportError"),
      onClick: () => openErrorReport(context, { force: true }),
    },
  });
}

function createFailedJobContext(
  jobState: JobState,
  summary: string,
): ErrorReportContext {
  return {
    source: "job-failure",
    summary,
    message: jobState.detail || jobState.progressText || summary,
    jobStage: jobState.phase || jobState.progressText || undefined,
  };
}
