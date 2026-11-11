import {
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  useSyncExternalStore,
} from "react";
import type { AppActivityState } from "../../../shared/appActivityTypes";
import {
  activityResourcesConflict,
  pageContentResource,
} from "../../../shared/appActivityTypes";
import { appGateway } from "../api/appGateway";
import { pendingPageEdits } from "../lib/pageEditBarrier";
import { useEventCallback } from "./useEventCallback";

type Gesture = { finish: () => void; finishing?: boolean };

export function usePageInputActivity(
  chapterId: string | undefined,
  pageId: string | null,
  state: AppActivityState | null,
) {
  const gestures = useRef(new Map<string, Gesture>());
  const activePages = useSyncExternalStore(
    pendingPageEdits.subscribe,
    pendingPageEdits.getActivePages,
  );
  useLayoutEffect(() => {
    pendingPageEdits.setHandingOff(
      (state?.pages ?? [])
        .filter((page) => page.phase === "finishing-edits")
        .map((page) => page.pageId),
    );
    return () => pendingPageEdits.setHandingOff([]);
  }, [state]);
  const begin = useEventCallback((id: string) => {
    if (!chapterId || !pageId) return;
    const previous = gestures.current.get(id);
    if (previous && !previous.finishing) return;
    if (
      state?.pages.some(
        (page) =>
          page.chapterId === chapterId &&
          page.pageId === pageId &&
          page.phase === "processing",
      )
    )
      return;
    if (
      state?.activities.some((activity) =>
        activityResourcesConflict(
          [pageContentResource(chapterId, pageId)],
          activity.resources,
        ),
      )
    )
      return;
    gestures.current.set(id, {
      finish: pendingPageEdits.begin(chapterId, pageId),
    });
  });
  const finish = useEventCallback((id: string) => {
    const gesture = gestures.current.get(id);
    if (!gesture || gesture.finishing) return;
    gesture.finishing = true;
    // Rich text schedules an IME fallback commit in its React composition-end
    // handler. Enqueue after that handler and accept its final beforeinput.
    queueMicrotask(() =>
      window.setTimeout(() => {
        if (gestures.current.get(id) === gesture) gestures.current.delete(id);
        gesture.finish();
      }, 0),
    );
  });
  const beforeInput = useEventCallback((event: InputEvent) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest(".editor-panel")
    )
      return;
    if (
      !pendingPageEdits.isHandingOff(pageId ?? undefined) ||
      gestures.current.has("composition")
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
  });
  const startComposition = useEventCallback(() => {
    if (!pendingPageEdits.isHandingOff(pageId ?? undefined))
      begin("composition");
  });
  usePageInputListeners(gestures, begin, finish, beforeInput, startComposition);
  return activePages;
}

export function usePageEditHandoff(
  state: AppActivityState | null,
  savePage: (chapterId: string, pageId: string) => Promise<void>,
  current?: { chapterId: string; pageIds: string[] },
): void {
  const pending = useRef(new Set<string>());
  const flush = useEventCallback(savePage);
  const flushEnvironment = useEventCallback(async () => {
    if (!current) return;
    for (const pageId of current.pageIds) {
      await pendingPageEdits.flushEditors(current.chapterId, pageId);
      await flush(current.chapterId, pageId);
    }
  });
  useEffect(() => {
    const unregister =
      pendingPageEdits.registerEnvironmentFlusher(flushEnvironment);
    const disconnect = observeSlowHandoffFrames();
    return () => {
      unregister();
      disconnect();
    };
  }, [flushEnvironment]);
  useEffect(() => {
    const activeRequests = new Set(state?.pages.map((page) => page.requestId));
    for (const id of pending.current)
      if (!activeRequests.has(id)) pending.current.delete(id);
    for (const page of state?.pages ?? []) {
      const requestId = page.requestId;
      if (
        (page.phase !== "finishing-edits" && page.phase !== "waiting") ||
        !requestId ||
        pending.current.has(requestId)
      )
        continue;
      // A busy renderer can receive only the timeout snapshot. The request is
      // still live: finish it once, then let the main process recheck edits.
      pending.current.add(requestId);
      void acknowledgePageEditHandoff(page, requestId, flush).catch((error) =>
        console.error("Could not acknowledge page edit handoff", error),
      );
    }
  }, [state, flush]);
}

function observeSlowHandoffFrames(): () => void {
  if (
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")
  )
    return () => {};
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < 250) continue;
      const frame = entry as PerformanceEntry & {
        blockingDuration?: number;
        scripts?: Array<{
          duration: number;
          invoker: string;
          sourceURL: string;
          sourceFunctionName: string;
          forcedStyleAndLayoutDuration: number;
        }>;
      };
      console.warn(
        "Slow renderer frame",
        JSON.stringify({
          startedAt: new Date(
            performance.timeOrigin + entry.startTime,
          ).toISOString(),
          durationMs: Math.round(entry.duration),
          blockingMs: Math.round(frame.blockingDuration ?? 0),
          scripts: [...(frame.scripts ?? [])]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 3)
            .map((script) => ({
              durationMs: Math.round(script.duration),
              invoker: script.invoker,
              source: script.sourceURL,
              function: script.sourceFunctionName,
              forcedLayoutMs: Math.round(script.forcedStyleAndLayoutDuration),
            })),
        }),
      );
    }
  });
  observer.observe({ type: "long-animation-frame", buffered: true });
  return () => observer.disconnect();
}

async function acknowledgePageEditHandoff(
  page: { chapterId: string; pageId: string },
  requestId: string,
  flush: (chapterId: string, pageId: string) => Promise<void>,
): Promise<void> {
  let stage = "flush-editors";
  const startedAt = performance.now();
  const trace = (event: string, detail: Record<string, unknown> = {}) =>
    console.debug(
      "Page edit handoff",
      JSON.stringify({
        requestId,
        chapterId: page.chapterId,
        pageId: page.pageId,
        event,
        stage,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...detail,
      }),
    );
  trace("received");
  const timer = window.setTimeout(() => {
    console.warn(
      "Page edit handoff is still pending",
      JSON.stringify({
        requestId,
        chapterId: page.chapterId,
        pageId: page.pageId,
        stage,
        activeInput: pendingPageEdits
          .getActivePages()
          .has(`${page.chapterId}/${page.pageId}`),
        visibility: document.visibilityState,
        focused: document.hasFocus(),
      }),
    );
  }, 10000);
  try {
    let error: string | undefined;
    try {
      await pendingPageEdits.flushEditors(page.chapterId, page.pageId);
      stage = "save-page";
      trace("editors-flushed");
      await flush(page.chapterId, page.pageId);
      trace("saved");
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      trace("failed", { error });
    }
    stage = "acknowledge";
    const accepted = await appGateway.finishPageEditHandoff({
      requestId,
      ...(error ? { error } : {}),
    });
    trace("acknowledged", { accepted });
  } finally {
    window.clearTimeout(timer);
  }
}

function usePageInputListeners(
  gestures: MutableRefObject<Map<string, Gesture>>,
  begin: (id: string) => void,
  finish: (id: string) => void,
  beforeInput: (event: InputEvent) => void,
  startComposition: () => void,
): void {
  useEffect(() => {
    const activeGestures = gestures.current;
    const down = (event: PointerEvent) => begin(`pointer:${event.pointerId}`);
    const up = (event: PointerEvent) => finish(`pointer:${event.pointerId}`);
    const blur = () => {
      // A release outside the window need not reach the document. End only
      // pointer bookkeeping; durable image writes and IME still own their work.
      for (const id of activeGestures.keys())
        if (id.startsWith("pointer:")) finish(id);
    };
    const compositionStart = startComposition;
    const compositionEnd = () => finish("composition");
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", blur);
    document.addEventListener("compositionstart", compositionStart, true);
    document.addEventListener("compositionend", compositionEnd, true);
    document.addEventListener("beforeinput", beforeInput, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", blur);
      document.removeEventListener("compositionstart", compositionStart, true);
      document.removeEventListener("compositionend", compositionEnd, true);
      document.removeEventListener("beforeinput", beforeInput, true);
      for (const gesture of activeGestures.values()) gesture.finish();
      activeGestures.clear();
    };
  }, [gestures, begin, finish, beforeInput, startComposition]);
}
