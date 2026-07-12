import React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { JobEvent, JobState } from "../../../shared/jobTypes";
import {
  resolveStatusLineReplacement,
  statusLineReplacementGroup,
} from "../lib/appHelpers";
import { formatJobEventLine, formatJobLabel } from "../lib/jobProgress";
import { mangaGateway } from "../api/mangaGateway";

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
  setJobState,
}: UseJobEventsOptions): void {
  const { t } = useTranslation("renderer");
  React.useEffect(() => {
    const refreshScheduler = createLibraryRefreshScheduler(refreshLibrary);
    const previousLineByGroup = new Map<string, string>();
    const unsubscribe = mangaGateway.onJobEvent((event) => {
      setJobState((current) => reduceJobState(current, event, t));
      appendJobStatusLine(event, appendStatusLine, previousLineByGroup, t);
      refreshLiveChapterAfterJobEvent({
        event,
        currentChapterRef,
        mergeLiveChapter,
        scheduleRefreshLibrary: refreshScheduler.schedule,
      });
    });
    return () => {
      refreshScheduler.dispose();
      unsubscribe();
    };
  }, [
    appendStatusLine,
    currentChapterRef,
    mergeLiveChapter,
    refreshLibrary,
    setJobState,
    t,
  ]);
}

function createLibraryRefreshScheduler(refreshLibrary: () => Promise<void>): {
  schedule: () => void;
  dispose: () => void;
} {
  let refreshTimer: number | null = null;
  const dispose = () => {
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
    }
  };
  const schedule = () => {
    dispose();
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void refreshLibrary().catch((error) => {
        console.error(error);
      });
    }, 250);
  };
  return { schedule, dispose };
}

function reduceJobState(
  current: JobState,
  event: JobEvent,
  t: TFunction<"renderer">,
): JobState {
  const sameJob = current.id === event.id;
  const preserveCurrentStatus = sameJob && isLogOnlyEvent(event);
  return {
    id: event.id,
    kind: preserveCurrentStatus ? current.kind : event.kind,
    status: preserveCurrentStatus ? current.status : event.status,
    progressText: preserveCurrentStatus
      ? current.progressText
      : formatJobLabel(event, t),
    detail: keepOrFallback(preserveCurrentStatus, current.detail, event.detail),
    phase: keepOrFallback(preserveCurrentStatus, current.phase, event.phase),
    progressMode: keepOrEvent(
      preserveCurrentStatus,
      current.progressMode,
      event.progressMode,
    ),
    progressPercent: keepOrEvent(
      preserveCurrentStatus,
      current.progressPercent,
      event.progressPercent,
    ),
    progressBytes: keepOrEvent(
      preserveCurrentStatus,
      current.progressBytes,
      event.progressBytes,
    ),
    progressTotalBytes: keepOrEvent(
      preserveCurrentStatus,
      current.progressTotalBytes,
      event.progressTotalBytes,
    ),
    progressBytesPerSecond: keepOrEvent(
      preserveCurrentStatus,
      current.progressBytesPerSecond,
      event.progressBytesPerSecond,
    ),
    installLogLine: event.installLogLine,
    installLogLines: resolveInstallLogLines(current, event, sameJob),
    progressCurrent: keepOrFallback(
      preserveCurrentStatus,
      current.progressCurrent,
      event.progressCurrent,
    ),
    progressTotal: keepOrFallback(
      preserveCurrentStatus,
      current.progressTotal,
      event.progressTotal,
    ),
    pageIndex: keepOrFallback(
      preserveCurrentStatus,
      current.pageIndex,
      event.pageIndex,
    ),
    pageTotal: keepOrFallback(
      preserveCurrentStatus,
      current.pageTotal,
      event.pageTotal,
    ),
    attempt: keepOrFallback(
      preserveCurrentStatus,
      current.attempt,
      event.attempt,
    ),
    attemptTotal: keepOrFallback(
      preserveCurrentStatus,
      current.attemptTotal,
      event.attemptTotal,
    ),
  };
}

function keepOrEvent<T>(preserve: boolean, current: T, eventValue: T): T {
  return preserve ? current : eventValue;
}

function keepOrFallback<T>(
  preserve: boolean,
  current: T | undefined,
  eventValue: T | undefined,
): T | undefined {
  return preserve ? current : (eventValue ?? current);
}

function resolveInstallLogLines(
  current: JobState,
  event: JobEvent,
  sameJob: boolean,
): string[] | undefined {
  if (event.installLogLine) {
    return [
      ...(sameJob ? (current.installLogLines ?? []) : []),
      event.installLogLine,
    ].slice(-80);
  }
  return sameJob ? current.installLogLines : undefined;
}

function appendJobStatusLine(
  event: JobEvent,
  appendStatusLine: UseJobEventsOptions["appendStatusLine"],
  previousLineByGroup: Map<string, string>,
  t: TFunction<"renderer">,
): void {
  if (isLogOnlyEvent(event)) {
    return;
  }
  const line = formatJobEventLine(event, t);
  const group = statusLineReplacementGroup(event);
  appendStatusLine(
    line,
    resolveStatusLineReplacement(
      event,
      group ? previousLineByGroup.get(group) : undefined,
    ),
  );
  if (group) {
    previousLineByGroup.set(group, line);
  }
}

function refreshLiveChapterAfterJobEvent({
  event,
  currentChapterRef,
  mergeLiveChapter,
  scheduleRefreshLibrary,
}: {
  event: JobEvent;
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  scheduleRefreshLibrary: () => void;
}): void {
  if (!shouldRefreshLiveChapter(event)) {
    return;
  }
  const chapterId = currentChapterRef.current?.id;
  if (!chapterId) {
    return;
  }

  void mangaGateway
    .openChapter(chapterId)
    .then((chapter) => {
      if (currentChapterRef.current?.id === chapter.id) {
        mergeLiveChapter(chapter);
      }
    })
    .then(scheduleRefreshLibrary)
    .catch((error) => {
      console.error(error);
    });
}

function shouldRefreshLiveChapter(event: JobEvent): boolean {
  return (
    event.phase === "page_done" ||
    event.phase === "page_skipped" ||
    event.phase === "inpainting_done"
  );
}

function isLogOnlyEvent(event: JobEvent): boolean {
  return Boolean(event.installLogLine && event.progressMode === "log-only");
}
