import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { StartAnalysisRequest } from "../../../shared/analysisTypes";
import { markChapterPagesRunning } from "./chapterSync";
export function markOpenChapterRunning({
  currentChapter,
  currentChapterRef,
  pageId,
  pageIds,
  runMode,
  setCurrentChapter,
}: {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  pageId?: string;
  pageIds?: string[];
  runMode: StartAnalysisRequest["runMode"];
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
}): void {
  if (!currentChapter) {
    return;
  }
  const optimisticChapter = markChapterPagesRunning(
    currentChapter,
    runMode,
    pageId,
    pageIds,
  );
  currentChapterRef.current = optimisticChapter;
  setCurrentChapter(optimisticChapter);
}
