import React from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { LinkedWorkspaceStatus } from "../../../shared/linkedWorkspaceTypes";
import { linkedWorkspaceGateway } from "../api/linkedWorkspaceGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import { useLinkedWorkspaceStatuses } from "./useLinkedWorkspaceStatuses";

export function useLinkedWorkspaceController({
  currentChapter,
  currentPageId,
  pushStatus,
  saveNow,
}: {
  currentChapter: ChapterSnapshot | null;
  currentPageId: string | null;
  pushStatus: (line: string) => void;
  saveNow: () => Promise<void>;
}): {
  status: LinkedWorkspaceStatus | null;
  viewBusy: boolean;
  viewResults: () => Promise<void>;
} {
  const chapterId = currentChapter?.id ?? null;
  const chapterIds = React.useMemo(
    () => (chapterId ? [chapterId] : []),
    [chapterId],
  );
  const { statuses } = useLinkedWorkspaceStatuses(chapterIds);
  const [viewBusy, setViewBusy] = React.useState(false);
  const viewResults = React.useCallback(async (): Promise<void> => {
    if (!chapterId || viewBusy) return;
    setViewBusy(true);
    try {
      await saveNow();
      const result = await linkedWorkspaceGateway.viewLinkedResults({
        chapterId,
        ...(currentPageId ? { currentPageId } : {}),
      });
      if (result.status === "failed") pushStatus(result.message);
    } catch (error) {
      pushStatus(formatErrorMessage(error, "결과 폴더를 열지 못했습니다."));
    } finally {
      setViewBusy(false);
    }
  }, [chapterId, currentPageId, pushStatus, saveNow, viewBusy]);
  return {
    status: chapterId ? (statuses.get(chapterId) ?? null) : null,
    viewBusy,
    viewResults,
  };
}
