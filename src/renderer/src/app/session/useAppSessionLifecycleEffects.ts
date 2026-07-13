import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Dispatch, SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type { JobState } from "../../../../shared/jobTypes";
import type { RegionSelectionState } from "../../lib/appHelpers";
import { toast } from "../../lib/toastStore";
import { formatJobLabel } from "../../lib/jobProgress";

type UseAppSessionLifecycleEffectsArgs = {
  currentChapter: ChapterSnapshot | null;
  jobState: JobState;
  onJobStart: () => void;
  onPageChange: () => void;
  openLogFolder: () => void | Promise<void>;
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
  openLogFolder,
  refreshLibrary,
  resetChapterScopedUi,
  selectedPageId,
  setRegionSelection,
  translationFlowActive,
}: UseAppSessionLifecycleEffectsArgs): void {
  const { t } = useTranslation("renderer");
  const prevJobStatusRef = useRef<JobState["status"]>("idle");
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
    if (next === "starting" || next === "running") {
      onJobStart();
    } else if (next === "completed") {
      if (!translationFlowActive) {
        toast.success(
          formatJobLabel(jobState, t) || t("job.notifications.completed"),
        );
      }
    } else if (next === "failed") {
      toast.error(
        formatJobLabel(jobState, t) || t("job.notifications.failed"),
        {
          action: {
            label: t("job.notifications.openLogs"),
            onClick: openLogFolder,
          },
        },
      );
    } else if (next === "cancelled") {
      toast.info(t("job.notifications.cancelled"));
    }
  }, [jobState, onJobStart, openLogFolder, translationFlowActive, t]);
}
