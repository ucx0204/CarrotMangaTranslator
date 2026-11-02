import React from "react";
import { createLibraryRefreshCoordinator } from "../lib/libraryRefreshCoordinator";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import type { JobEvent, JobState } from "../../../shared/jobTypes";
import type { PageTimingUpdatedEvent } from "../../../shared/pageProcessingTiming";
import { isTerminalJobStatus } from "../../../shared/jobContracts";
import {
  resolveStatusLineReplacement,
  statusLineReplacementGroup,
} from "../lib/appHelpers";
import { formatJobEventLine } from "../lib/jobProgress";
import { toast } from "../lib/toastStore";
import { noteMcpJobEvent } from "../lib/mcpNotificationBatch";
import { createLiveChapterRefreshCoordinator } from "../lib/liveChapterRefreshCoordinator";
import { analysisGateway as mangaGateway } from "../api/analysisGateway";
import { libraryGateway } from "../api/libraryGateway";
import {
  createAggregateJobEventGuard,
  shouldIgnoreAggregateJobEvent,
  updateAggregateJobEventGuard,
  type AggregateJobEventGuard,
} from "./jobEventFlowGuard";
import {
  isLogOnlyEvent,
  resolveAnimationFrameScheduler,
  shouldRefreshLiveChapter,
} from "./jobEventUtils";
import { reduceJobEventBatch } from "./jobEventState";
import type { AppendStatusLine } from "./useStatusLog";
type UseJobEventsOptions = {
  appendStatusLine: AppendStatusLine;
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  jobState?: JobState;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  onJobTerminal?: (job: JobState) => void;
  setLibrary?: (library: LibraryIndex) => void;
  openChapter?: (
    chapterId: string,
    workId?: string,
  ) => Promise<ChapterSnapshot>;
  setJobState: React.Dispatch<React.SetStateAction<JobState>>;
  suppressTerminalEvents?: boolean;
  subscribeJobEvents?: (callback: (event: JobEvent) => void) => () => void;
  subscribePageTimingUpdates?: (
    callback: (event: PageTimingUpdatedEvent) => void,
  ) => () => void;
};

type JobEventSubscriptionOptions = Required<
  Pick<
    UseJobEventsOptions,
    | "appendStatusLine"
    | "currentChapterRef"
    | "mergeLiveChapter"
    | "openChapter"
    | "setJobState"
    | "subscribeJobEvents"
    | "subscribePageTimingUpdates"
    | "suppressTerminalEvents"
  >
> & {
  onJobTerminal?: (job: JobState) => void;
  setLibrary?: (library: LibraryIndex) => void;
  aggregateGuardRef: React.MutableRefObject<AggregateJobEventGuard>;
  jobStateRef: React.MutableRefObject<JobState | undefined>;
  t: TFunction<"renderer">;
};

type PendingJobEventBatch = {
  dispose: () => void;
  enqueue: (event: JobEvent) => void;
};

const openChapterFromLibrary = (
  chapterId: string,
  workId?: string,
): Promise<ChapterSnapshot> => libraryGateway.openChapter(chapterId, workId);

const subscribeToJobEvents = (
  callback: (event: JobEvent) => void,
): (() => void) => mangaGateway.onJobEvent(callback);

const subscribeToPageTimingUpdates = (
  callback: (event: PageTimingUpdatedEvent) => void,
): (() => void) => mangaGateway.onPageTimingUpdated(callback);

const skipPageTimingUpdates = (): (() => void) => () => undefined;

export function useJobEvents({
  appendStatusLine,
  currentChapterRef,
  jobState,
  mergeLiveChapter,
  onJobTerminal,
  setLibrary,
  openChapter = openChapterFromLibrary,
  setJobState,
  suppressTerminalEvents = false,
  subscribeJobEvents: subscribeJobEventsOverride,
  subscribePageTimingUpdates: subscribePageTimingUpdatesOverride,
}: UseJobEventsOptions): void {
  const { t } = useTranslation("renderer");
  const subscribeJobEvents = subscribeJobEventsOverride ?? subscribeToJobEvents;
  const subscribePageTimingUpdates =
    subscribePageTimingUpdatesOverride ??
    (subscribeJobEventsOverride
      ? skipPageTimingUpdates
      : subscribeToPageTimingUpdates);
  const aggregateGuardRef = React.useRef<AggregateJobEventGuard>(
    createAggregateJobEventGuard(),
  );
  const jobStateRef = React.useRef(jobState);
  React.useEffect(() => {
    jobStateRef.current = jobState;
  }, [jobState]);
  React.useEffect(() => {
    updateAggregateJobEventGuard(
      aggregateGuardRef.current,
      suppressTerminalEvents,
    );
  }, [suppressTerminalEvents]);
  React.useEffect(
    () =>
      subscribeToJobEventUpdates({
        aggregateGuardRef,
        appendStatusLine,
        currentChapterRef,
        jobStateRef,
        mergeLiveChapter,
        onJobTerminal,
        setLibrary,
        openChapter,
        setJobState,
        subscribeJobEvents,
        subscribePageTimingUpdates,
        suppressTerminalEvents,
        t,
      }),
    [
      appendStatusLine,
      currentChapterRef,
      mergeLiveChapter,
      onJobTerminal,
      setLibrary,
      openChapter,
      setJobState,
      subscribeJobEvents,
      subscribePageTimingUpdates,
      suppressTerminalEvents,
      t,
    ],
  );
}

function subscribeToJobEventUpdates({
  aggregateGuardRef,
  appendStatusLine,
  currentChapterRef,
  jobStateRef,
  mergeLiveChapter,
  onJobTerminal,
  setLibrary,
  openChapter,
  setJobState,
  subscribeJobEvents,
  subscribePageTimingUpdates,
  suppressTerminalEvents,
  t,
}: JobEventSubscriptionOptions): () => void {
  const refresh = createJobChapterRefresh({
    currentChapterRef,
    mergeLiveChapter,
    openChapter,
    setLibrary,
  });
  const pendingBatch = createPendingJobEventBatch({
    aggregateGuardRef,
    appendStatusLine,
    jobStateRef,
    setJobState,
    suppressTerminalEvents,
    t,
  });
  const unsubscribe = subscribeJobEvents((event) => {
    // Completion is per job, before the display reducer selects a foreground.
    if (
      isTerminalJobStatus(event.status) &&
      !suppressTerminalEvents &&
      !aggregateGuardRef.current.protectedJobIds.has(event.id)
    ) {
      onJobTerminal?.(event);
    }
    if (
      shouldIgnoreAggregateJobEvent(
        jobStateRef.current,
        event,
        aggregateGuardRef.current,
        suppressTerminalEvents,
      )
    ) {
      return;
    }
    if (suppressTerminalEvents) {
      aggregateGuardRef.current.activeJobIds.add(event.id);
    }
    const batched = noteMcpJobEvent(event);
    if (event.notification && !batched) {
      toast[event.notification.variant](event.notification.message);
    }
    pendingBatch.enqueue(event);
    refresh.request(event);
  });
  const unsubscribeTiming = subscribePageTimingUpdates(refresh.timing);

  return () => {
    pendingBatch.dispose();
    unsubscribe();
    unsubscribeTiming();
    refresh.dispose();
  };
}

function createPendingJobEventBatch({
  aggregateGuardRef,
  appendStatusLine,
  jobStateRef,
  setJobState,
  suppressTerminalEvents,
  t,
}: Pick<
  JobEventSubscriptionOptions,
  | "aggregateGuardRef"
  | "appendStatusLine"
  | "jobStateRef"
  | "setJobState"
  | "suppressTerminalEvents"
  | "t"
>): PendingJobEventBatch {
  const previousLineByGroup = new Map<string, string>();
  const pendingEvents: JobEvent[] = [];
  const { cancelFrame, requestFrame } = resolveAnimationFrameScheduler();
  let frameId: number | null = null;
  let disposed = false;
  const flushPendingEvents = (): void => {
    frameId = null;
    if (disposed || pendingEvents.length === 0) return;
    const events = pendingEvents
      .splice(0)
      .filter(
        (event) =>
          !shouldIgnoreAggregateJobEvent(
            jobStateRef.current,
            event,
            aggregateGuardRef.current,
            suppressTerminalEvents,
          ) &&
          (!suppressTerminalEvents || !isTerminalJobStatus(event.status)),
      );
    if (events.length === 0) return;
    React.startTransition(() => {
      setJobState((current) => reduceJobEventBatch(current, events, t));
      for (const event of events) {
        appendJobStatusLine(event, appendStatusLine, previousLineByGroup, t);
      }
    });
  };
  return {
    enqueue: (event) => {
      pendingEvents.push(event);
      if (frameId === null) {
        frameId = requestFrame(flushPendingEvents);
      }
    },
    dispose: () => {
      disposed = true;
      if (frameId !== null) {
        cancelFrame(frameId);
      }
      pendingEvents.length = 0;
    },
  };
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
  const baseGroup = statusLineReplacementGroup(event);
  const group = baseGroup ? `${event.id}:${baseGroup}` : baseGroup;
  appendStatusLine(
    line,
    resolveStatusLineReplacement(
      event,
      group ? previousLineByGroup.get(group) : undefined,
    ),
    resolveSingleEventChapterId(event),
  );
  if (group) {
    previousLineByGroup.set(group, line);
  }
}

function resolveSingleEventChapterId(event: JobEvent): string | undefined {
  if (event.workflowProgress?.chapterId)
    return event.workflowProgress.chapterId;
  const chapterIds = new Set(event.targets?.map((target) => target.chapterId));
  return chapterIds.size === 1 ? chapterIds.values().next().value : undefined;
}

function createJobChapterRefresh({
  currentChapterRef,
  mergeLiveChapter,
  openChapter,
  setLibrary,
}: Pick<
  JobEventSubscriptionOptions,
  "currentChapterRef" | "mergeLiveChapter" | "openChapter" | "setLibrary"
>) {
  const libraryRefresh = createLibraryRefreshCoordinator({
    read: () => libraryGateway.getLibrary(),
    publish: (library) => setLibrary?.(library),
    reportError: (error) => console.error(error),
  });
  const liveChapterRefresh = createLiveChapterRefreshCoordinator({
    getCurrentChapterId: () => currentChapterRef.current?.id,
    mergeLiveChapter,
    openChapter: (chapterId) =>
      openChapter === openChapterFromLibrary
        ? openChapter(chapterId, currentChapterRef.current?.workId)
        : openChapter(chapterId),
    reportError: (error) => {
      console.error(error);
    },
  });
  return {
    request: (event: JobEvent) => {
      if (!shouldRefreshLiveChapter(event)) return;
      if (event.workflowProgress && setLibrary) libraryRefresh.request();
      const chapterId = event.workflowProgress?.chapterId;
      if (!chapterId || chapterId === currentChapterRef.current?.id)
        liveChapterRefresh.request();
    },
    timing: (event: PageTimingUpdatedEvent) => {
      if (event.chapterId === currentChapterRef.current?.id)
        liveChapterRefresh.request();
    },
    dispose: () => {
      liveChapterRefresh.dispose();
      libraryRefresh.dispose();
    },
  };
}
