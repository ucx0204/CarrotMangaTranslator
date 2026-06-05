import React from "react";
import type { ChapterSnapshot, JobState } from "../../../shared/types";
import { resolveStatusLineReplacement } from "../lib/appHelpers";
import { formatJobEventLine, formatJobLabel } from "../lib/jobProgress";

type UseJobEventsOptions = {
  appendStatusLine: (line: string, replace?: (line: string) => boolean) => void;
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  refreshLibrary: () => Promise<void>;
  setJobState: React.Dispatch<React.SetStateAction<JobState>>;
};

export function useJobEvents({
  appendStatusLine,
  currentChapterRef,
  mergeLiveChapter,
  refreshLibrary,
  setJobState
}: UseJobEventsOptions): void {
  React.useEffect(() => {
    const unsubscribe = window.mangaApi.onJobEvent((event) => {
      setJobState((current) => {
        const sameJob = current.id === event.id;
        const logOnlyEvent = Boolean(event.installLogLine && event.progressMode === "log-only");
        const preserveCurrentStatus = sameJob && logOnlyEvent;
        const friendlyText = preserveCurrentStatus ? current.progressText : formatJobLabel(event);
        const preserveExactProgress = Boolean(event.installLogLine && sameJob && event.progressMode !== "log-only");
        return {
          id: event.id,
          kind: preserveCurrentStatus ? current.kind : event.kind,
          status: preserveCurrentStatus ? current.status : event.status,
          progressText: friendlyText,
          detail: preserveCurrentStatus ? current.detail : event.detail ?? current.detail,
          phase: preserveCurrentStatus ? current.phase : event.phase ?? current.phase,
          progressMode: preserveCurrentStatus ? current.progressMode : event.progressMode ?? (event.installLogLine && sameJob ? current.progressMode : undefined),
          progressPercent: preserveCurrentStatus ? current.progressPercent : event.progressPercent ?? (preserveExactProgress ? current.progressPercent : undefined),
          progressBytes: preserveCurrentStatus ? current.progressBytes : event.progressBytes ?? (preserveExactProgress ? current.progressBytes : undefined),
          progressTotalBytes: preserveCurrentStatus ? current.progressTotalBytes : event.progressTotalBytes ?? (preserveExactProgress ? current.progressTotalBytes : undefined),
          progressBytesPerSecond: preserveCurrentStatus
            ? current.progressBytesPerSecond
            : event.progressBytesPerSecond ?? (preserveExactProgress ? current.progressBytesPerSecond : undefined),
          installLogLine: event.installLogLine,
          installLogLines: event.installLogLine
            ? [...(sameJob ? current.installLogLines ?? [] : []), event.installLogLine].slice(-80)
            : sameJob
              ? current.installLogLines
              : undefined,
          progressCurrent: preserveCurrentStatus ? current.progressCurrent : event.progressCurrent ?? current.progressCurrent,
          progressTotal: preserveCurrentStatus ? current.progressTotal : event.progressTotal ?? current.progressTotal,
          pageIndex: preserveCurrentStatus ? current.pageIndex : event.pageIndex ?? current.pageIndex,
          pageTotal: preserveCurrentStatus ? current.pageTotal : event.pageTotal ?? current.pageTotal,
          attempt: preserveCurrentStatus ? current.attempt : event.attempt ?? current.attempt,
          attemptTotal: preserveCurrentStatus ? current.attemptTotal : event.attemptTotal ?? current.attemptTotal
        };
      });

      if (!(event.installLogLine && event.progressMode === "log-only")) {
        appendStatusLine(formatJobEventLine(event), resolveStatusLineReplacement(event));
      }

      if (event.phase === "page_done" || event.phase === "page_skipped" || event.phase === "inpainting_done") {
        const chapterId = currentChapterRef.current?.id;
        if (!chapterId) {
          return;
        }

        void window.mangaApi
          .openChapter(chapterId)
          .then((chapter) => {
            if (currentChapterRef.current?.id === chapter.id) {
              mergeLiveChapter(chapter);
            }
          })
          .then(() => refreshLibrary())
          .catch((error) => {
            console.error(error);
          });
      }
    });
    return unsubscribe;
  }, [appendStatusLine, currentChapterRef, mergeLiveChapter, refreshLibrary, setJobState]);
}
