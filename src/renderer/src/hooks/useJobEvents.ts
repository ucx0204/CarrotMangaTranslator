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
import {
  createLiveChapterRefreshCoordinator,
  type LiveChapterRefreshCoordinator,
} from "../lib/liveChapterRefreshCoordinator";
import { analysisGateway as mangaGateway } from "../api/analysisGateway";
import { libraryGateway } from "../api/libraryGateway";

type UseJobEventsOptions = {
  appendStatusLine: (line: string, replace?: (line: string) => boolean) => void;
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  openChapter?: (chapterId: string) => Promise<ChapterSnapshot>;
  setJobState: React.Dispatch<React.SetStateAction<JobState>>;
  subscribeJobEvents?: (callback: (event: JobEvent) => void) => () => void;
};

const openChapterFromLibrary = (chapterId: string): Promise<ChapterSnapshot> =>
  libraryGateway.openChapter(chapterId);
const subscribeToJobEvents = (
  callback: (event: JobEvent) => void,
): (() => void) => mangaGateway.onJobEvent(callback);

export function useJobEvents({
  appendStatusLine,
  currentChapterRef,
  mergeLiveChapter,
  openChapter = openChapterFromLibrary,
  setJobState,
  subscribeJobEvents = subscribeToJobEvents,
}: UseJobEventsOptions): void {
  const { t } = useTranslation("renderer");
  React.useEffect(() => {
    const previousLineByGroup = new Map<string, string>();
    const pendingEvents: JobEvent[] = [];
    let frameId: number | null = null;
    let disposed = false;
    const requestFrame =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (callback: FrameRequestCallback) =>
            window.setTimeout(() => callback(performance.now()), 0);
    const cancelFrame =
      typeof window.cancelAnimationFrame === "function"
        ? window.cancelAnimationFrame.bind(window)
        : window.clearTimeout.bind(window);
    const liveChapterRefresh = createLiveChapterRefreshCoordinator({
      getCurrentChapterId: () => currentChapterRef.current?.id,
      mergeLiveChapter,
      openChapter,
      reportError: (error) => {
        console.error(error);
      },
    });
    const flushPendingEvents = (): void => {
      frameId = null;
      if (disposed || pendingEvents.length === 0) return;
      const events = pendingEvents.splice(0);
      React.startTransition(() => {
        setJobState((current) => reduceJobEventBatch(current, events, t));
        for (const event of events) {
          appendJobStatusLine(event, appendStatusLine, previousLineByGroup, t);
        }
      });
    };
    const schedulePendingEvents = (): void => {
      if (frameId !== null) return;
      frameId = requestFrame(flushPendingEvents);
    };
    const unsubscribe = subscribeJobEvents((event) => {
      pendingEvents.push(event);
      schedulePendingEvents();
      refreshLiveChapterAfterJobEvent({
        event,
        liveChapterRefresh,
      });
    });
    return () => {
      disposed = true;
      if (frameId !== null) {
        cancelFrame(frameId);
      }
      pendingEvents.length = 0;
      unsubscribe();
      liveChapterRefresh.dispose();
    };
  }, [
    appendStatusLine,
    currentChapterRef,
    mergeLiveChapter,
    openChapter,
    setJobState,
    subscribeJobEvents,
    t,
  ]);
}

function reduceJobEventBatch(
  current: JobState,
  events: readonly JobEvent[],
  t: TFunction<"renderer">,
): JobState {
  return events.reduce(
    (next, event) => reduceJobState(next, event, t),
    current,
  );
}

function reduceJobState(
  current: JobState,
  event: JobEvent,
  t: TFunction<"renderer">,
): JobState {
  const sameJob = current.id === event.id;
  if (sameJob && isTerminalJobStatus(current.status)) {
    return current;
  }
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

function isTerminalJobStatus(status: JobState["status"]): boolean {
  return (
    status === "cancelled" || status === "failed" || status === "completed"
  );
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
  liveChapterRefresh,
}: {
  event: JobEvent;
  liveChapterRefresh: LiveChapterRefreshCoordinator;
}): void {
  if (!shouldRefreshLiveChapter(event)) {
    return;
  }
  liveChapterRefresh.request();
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
