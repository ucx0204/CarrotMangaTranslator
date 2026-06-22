import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type { JobState } from "../../../../shared/jobTypes";
import type { RegionSelectionState } from "../../lib/appHelpers";
import { toast } from "../../lib/toastStore";

type UseAppSessionLifecycleEffectsArgs = {
  currentChapter: ChapterSnapshot | null;
  jobState: JobState;
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
  openLogFolder,
  refreshLibrary,
  resetChapterScopedUi,
  selectedPageId,
  setRegionSelection,
  translationFlowActive,
}: UseAppSessionLifecycleEffectsArgs): void {
  const prevJobStatusRef = useRef<JobState["status"]>("idle");

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => {
    setRegionSelection(null);
  }, [selectedPageId, setRegionSelection]);

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
    if (next === "completed") {
      if (!translationFlowActive) {
        toast.success(jobState.progressText || "작업이 완료되었습니다.");
      }
    } else if (next === "failed") {
      toast.error(jobState.progressText || "작업에 실패했습니다.", {
        action: { label: "로그 폴더 열기", onClick: openLogFolder },
      });
    } else if (next === "cancelled") {
      toast.info("작업이 취소되었습니다.");
    }
  }, [
    jobState.status,
    jobState.progressText,
    openLogFolder,
    translationFlowActive,
  ]);
}
