import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Dispatch, SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type { JobState } from "../../../../shared/jobTypes";
import type { ErrorReportContext } from "../../../../shared/errorReportTypes";
import type { RegionSelectionState } from "../../lib/appHelpers";
import { toast } from "../../lib/toastStore";
import { formatJobLabel } from "../../lib/jobProgress";

type OpenErrorReport = (
  context: ErrorReportContext,
  options?: { force?: boolean },
) => unknown;

type UseAppSessionLifecycleEffectsArgs = {
  currentChapter: ChapterSnapshot | null;
  jobState: JobState;
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
  const reportedJobIdRef = useRef<string | null>(null);
  const previousPageIdRef = useRef(selectedPageId);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => {
    setRegionSelection(null);
  }, [selectedPageId, setRegionSelection]);

  useEffect(() => {
    if (previousPageIdRef.current === selectedPageId) return;
    previousPageIdRef.current = selectedPageId;
    onPageChange();
  }, [onPageChange, selectedPageId]);

  useEffect(() => {
    if (!currentChapter) {
      resetChapterScopedUi();
    }
  }, [currentChapter, resetChapterScopedUi]);

  useEffect(() => {
    const previous = prevJobStatusRef.current;
    const next = jobState.status;
    if (previous === next) {
      return;
    }
    prevJobStatusRef.current = next;
    handleJobStatusChange({
      jobState,
      onJobStart,
      openErrorReport,
      reportedJobIdRef,
      t,
      translationFlowActive,
    });
  }, [jobState, onJobStart, openErrorReport, translationFlowActive, t]);
}

type JobStatusChangeArgs = {
  jobState: JobState;
  onJobStart: () => void;
  openErrorReport: OpenErrorReport;
  reportedJobIdRef: { current: string | null };
  t: TFunction<"renderer">;
  translationFlowActive: boolean;
};

function handleJobStatusChange({
  jobState,
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
  if (next === "completed") {
    if (!translationFlowActive) {
      toast.success(
        formatJobLabel(jobState, t) || t("job.notifications.completed"),
      );
    }
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

function handleFailedJob({
  jobState,
  openErrorReport,
  reportedJobIdRef,
  t,
}: Pick<
  JobStatusChangeArgs,
  "jobState" | "openErrorReport" | "reportedJobIdRef" | "t"
>): void {
  const summary = formatJobLabel(jobState, t) || t("job.notifications.failed");
  const context = createFailedJobContext(jobState, summary);
  if (reportedJobIdRef.current !== jobState.id) {
    reportedJobIdRef.current = jobState.id;
    openErrorReport(context);
  }
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
