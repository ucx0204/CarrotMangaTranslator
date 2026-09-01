/* eslint-disable max-lines -- job batching and live chapter subscription cleanup share one lifecycle */
import React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { JobEvent, JobState } from "../../../shared/jobTypes";
import type { PageTimingUpdatedEvent } from "../../../shared/pageProcessingTiming";
import { isTerminalJobStatus } from "../../../shared/jobContracts";
import {
  resolveInstallLogLines,
  resolveStatusLineReplacement,
  statusLineReplacementGroup,
} from "../lib/appHelpers";
import { formatJobEventLine, formatJobLabel } from "../lib/jobProgress";
import { toast } from "../lib/toastStore";
import {
  createLiveChapterRefreshCoordinator,
  type LiveChapterRefreshCoordinator,
} from "../lib/liveChapterRefreshCoordinator";
import { analysisGateway as mangaGateway } from "../api/analysisGateway";
import { libraryGateway } from "../api/libraryGateway";
import {
  createAggregateJobEventGuard,
  isAggregateFlowTerminal,
  shouldIgnoreAggregateJobEvent,
  updateAggregateJobEventGuard,
  type AggregateJobEventGuard,
} from "./jobEventFlowGuard";
import {
  isLogOnlyEvent,
  resolveAnimationFrameScheduler,
  shouldRefreshLiveChapter,
} from "./jobEventUtils";
import type { AppendStatusLine } from "./useStatusLog";

type UseJobEventsOptions = {
  appendStatusLine: AppendStatusLine;
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  jobState?: JobState;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  openChapter?: (chapterId: string) => Promise<ChapterSnapshot>;
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
  aggregateGuardRef: React.MutableRefObject<AggregateJobEventGuard>;
  jobStateRef: React.MutableRefObject<JobState | undefined>;
  t: TFunction<"renderer">;
};

type PendingJobEventBatch = {
  dispose: () => void;
  enqueue: (event: JobEvent) => void;
};

type NextJobStateOptions = {
  current: JobState;
  event: JobEvent;
  preserveCurrentStatus: boolean;
  sameJob: boolean;
  t: TFunction<"renderer">;
};

type NextProgressState = Pick<
  JobState,
  | "progressMode"
  | "progressPercent"
  | "progressBytes"
  | "progressTotalBytes"
  | "progressBytesPerSecond"
>;

const openChapterFromLibrary = (chapterId: string): Promise<ChapterSnapshot> =>
  libraryGateway.openChapter(chapterId);
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
  openChapter,
  setJobState,
  subscribeJobEvents,
  subscribePageTimingUpdates,
  suppressTerminalEvents,
  t,
}: JobEventSubscriptionOptions): () => void {
  const liveChapterRefresh = createLiveChapterRefreshCoordinator({
    getCurrentChapterId: () => currentChapterRef.current?.id,
    mergeLiveChapter,
    openChapter,
    reportError: (error) => {
      console.error(error);
    },
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
    if (event.notification) {
      toast[event.notification.variant](event.notification.message);
    }
    pendingBatch.enqueue(event);
    refreshLiveChapterAfterJobEvent({ event, liveChapterRefresh });
  });
  const unsubscribeTiming = subscribePageTimingUpdates((event) => {
    if (event.chapterId === currentChapterRef.current?.id) {
      liveChapterRefresh.request();
    }
  });
  return () => {
    pendingBatch.dispose();
    unsubscribe();
    unsubscribeTiming();
    liveChapterRefresh.dispose();
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
  if (
    isAggregateFlowTerminal(current) &&
    event.id !== current.id &&
    isTerminalJobStatus(event.status)
  ) {
    return current;
  }
  const sameJob = current.id === event.id;
  if (sameJob && isTerminalJobStatus(current.status)) {
    return current;
  }
  const preserveCurrentStatus = sameJob && isLogOnlyEvent(event);
  return buildNextJobState({
    current,
    event,
    preserveCurrentStatus,
    sameJob,
    t,
  });
}

function buildNextJobState({
  current,
  event,
  preserveCurrentStatus,
  sameJob,
  t,
}: NextJobStateOptions): JobState {
  return {
    id: event.id,
    kind: preserveCurrentStatus ? current.kind : event.kind,
    status: preserveCurrentStatus ? current.status : event.status,
    progressText: preserveCurrentStatus
      ? current.progressText
      : formatJobLabel(event, t),
    detail: keepOrFallback(preserveCurrentStatus, current.detail, event.detail),
    phase: keepOrFallback(preserveCurrentStatus, current.phase, event.phase),
    ocrPipeline: keepOrFallback(
      preserveCurrentStatus,
      current.ocrPipeline,
      event.ocrPipeline,
    ),
    ...resolveNextProgressState(current, event, preserveCurrentStatus),
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
    failureGuidance:
      event.failureGuidance ?? (sameJob ? current.failureGuidance : undefined),
    research: event.research ?? (sameJob ? current.research : undefined),
    targets: event.targets ?? (sameJob ? current.targets : undefined),
  };
}

function resolveNextProgressState(
  current: JobState,
  event: JobEvent,
  preserveCurrentStatus: boolean,
): NextProgressState {
  return {
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
    resolveSingleEventChapterId(event),
  );
  if (group) {
    previousLineByGroup.set(group, line);
  }
}

function resolveSingleEventChapterId(event: JobEvent): string | undefined {
  const chapterIds = new Set(event.targets?.map((target) => target.chapterId));
  return chapterIds.size === 1 ? chapterIds.values().next().value : undefined;
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
