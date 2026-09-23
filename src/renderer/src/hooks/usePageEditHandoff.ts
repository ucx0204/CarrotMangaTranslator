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
  useEffect(
    () => pendingPageEdits.registerEnvironmentFlusher(flushEnvironment),
    [flushEnvironment],
  );
  useEffect(() => {
    const activeRequests = new Set(state?.pages.map((page) => page.requestId));
    for (const id of pending.current)
      if (!activeRequests.has(id)) pending.current.delete(id);
    for (const page of state?.pages ?? []) {
      const requestId = page.requestId;
      if (
        page.phase !== "finishing-edits" ||
        !requestId ||
        pending.current.has(requestId)
      )
        continue;
      pending.current.add(requestId);
      void (async () => {
        let error: string | undefined;
        try {
          await pendingPageEdits.flushEditors(page.chapterId, page.pageId);
          await flush(page.chapterId, page.pageId);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        await appGateway.finishPageEditHandoff({
          requestId,
          ...(error ? { error } : {}),
        });
      })().catch((error) =>
        console.error("Could not acknowledge page edit handoff", error),
      );
    }
  }, [state, flush]);
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
    const compositionStart = startComposition;
    const compositionEnd = () => finish("composition");
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("compositionstart", compositionStart, true);
    document.addEventListener("compositionend", compositionEnd, true);
    document.addEventListener("beforeinput", beforeInput, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("compositionstart", compositionStart, true);
      document.removeEventListener("compositionend", compositionEnd, true);
      document.removeEventListener("beforeinput", beforeInput, true);
      for (const gesture of activeGestures.values()) gesture.finish();
      activeGestures.clear();
    };
  }, [gestures, begin, finish, beforeInput, startComposition]);
}
