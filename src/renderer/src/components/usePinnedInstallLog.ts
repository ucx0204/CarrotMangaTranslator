import React from "react";
import type { JobState } from "../../../shared/jobTypes";

const BOTTOM_TOLERANCE_PX = 2;

export type PinnedInstallLogBindings = {
  handleLogKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  handleLogScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  handleLogWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
  handleOverlayPointerEndCapture: (
    event: React.PointerEvent<HTMLDivElement>,
  ) => void;
  handleOverlayPointerStartCapture: (
    event: React.PointerEvent<HTMLDivElement>,
  ) => void;
  logContentRef: React.RefObject<HTMLDivElement | null>;
  logRef: React.RefObject<HTMLDivElement | null>;
};

type PinnedLogController = {
  detachFromBottom: () => void;
  pinnedRef: React.RefObject<boolean>;
  schedulePinnedScroll: () => void;
  scrollLogToBottom: () => void;
  scrollLogToBottomIfPinned: () => void;
};

export function usePinnedInstallLog(job: JobState): PinnedInstallLogBindings {
  const logContentRef = React.useRef<HTMLDivElement | null>(null);
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const controller = usePinnedLogController(logRef);

  usePinnedLogEffects(job, logContentRef, controller);
  const scrollHandlers = useLogScrollHandlers(controller);
  const pointerHandlers = useLogPointerHandlers(logRef, controller);

  return {
    ...scrollHandlers,
    ...pointerHandlers,
    logContentRef,
    logRef,
  };
}

function usePinnedLogController(
  logRef: React.RefObject<HTMLDivElement | null>,
): PinnedLogController {
  const pinnedRef = React.useRef(true);
  const pendingFrameRef = React.useRef<number | null>(null);
  const cancelPendingScroll = React.useCallback(() => {
    if (pendingFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }
  }, []);
  const scrollLogToBottom = React.useCallback(() => {
    const element = logRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [logRef]);
  const scrollLogToBottomIfPinned = React.useCallback(() => {
    if (pinnedRef.current) {
      scrollLogToBottom();
    }
  }, [scrollLogToBottom]);
  const schedulePinnedScroll = React.useCallback(() => {
    cancelPendingScroll();
    pendingFrameRef.current = window.requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      scrollLogToBottomIfPinned();
    });
  }, [cancelPendingScroll, scrollLogToBottomIfPinned]);
  const detachFromBottom = React.useCallback(() => {
    pinnedRef.current = false;
    cancelPendingScroll();
  }, [cancelPendingScroll]);

  React.useEffect(() => () => cancelPendingScroll(), [cancelPendingScroll]);

  return {
    detachFromBottom,
    pinnedRef,
    schedulePinnedScroll,
    scrollLogToBottom,
    scrollLogToBottomIfPinned,
  };
}

function usePinnedLogEffects(
  job: JobState,
  logContentRef: React.RefObject<HTMLDivElement | null>,
  controller: PinnedLogController,
): void {
  const {
    pinnedRef,
    schedulePinnedScroll,
    scrollLogToBottom,
    scrollLogToBottomIfPinned,
  } = controller;
  const hasLogLines = Boolean(job.installLogLines?.length);

  React.useLayoutEffect(() => {
    if (pinnedRef.current) {
      scrollLogToBottom();
      schedulePinnedScroll();
    }
  }, [job.installLogLines, pinnedRef, schedulePinnedScroll, scrollLogToBottom]);

  React.useLayoutEffect(() => {
    pinnedRef.current = true;
    scrollLogToBottom();
    schedulePinnedScroll();
  }, [job.id, job.phase, pinnedRef, schedulePinnedScroll, scrollLogToBottom]);

  React.useLayoutEffect(() => {
    const content = logContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      scrollLogToBottomIfPinned();
      if (pinnedRef.current) {
        schedulePinnedScroll();
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [
    hasLogLines,
    job.phase,
    logContentRef,
    pinnedRef,
    schedulePinnedScroll,
    scrollLogToBottomIfPinned,
  ]);
}

function useLogScrollHandlers(
  controller: PinnedLogController,
): Pick<
  PinnedInstallLogBindings,
  "handleLogKeyDown" | "handleLogScroll" | "handleLogWheel"
> {
  const { detachFromBottom, pinnedRef } = controller;
  const handleLogScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (isScrolledNearBottom(event.currentTarget)) {
        pinnedRef.current = true;
      }
    },
    [pinnedRef],
  );
  const handleLogWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (event.deltaY < 0) {
        detachFromBottom();
      }
    },
    [detachFromBottom],
  );
  const handleLogKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isUpwardScrollKey(event)) {
        detachFromBottom();
        event.stopPropagation();
      }
    },
    [detachFromBottom],
  );

  return { handleLogKeyDown, handleLogScroll, handleLogWheel };
}

function useLogPointerHandlers(
  logRef: React.RefObject<HTMLDivElement | null>,
  controller: PinnedLogController,
): Pick<
  PinnedInstallLogBindings,
  "handleOverlayPointerEndCapture" | "handleOverlayPointerStartCapture"
> {
  const { detachFromBottom, pinnedRef } = controller;
  const pointerScrollingRef = React.useRef(false);
  const pointerStartScrollTopRef = React.useRef(0);
  const handleOverlayPointerStartCapture = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = logRef.current;
      if (element?.contains(event.target as Node)) {
        pointerScrollingRef.current = true;
        pointerStartScrollTopRef.current = element.scrollTop;
      }
      event.stopPropagation();
    },
    [logRef],
  );
  const handleOverlayPointerEndCapture = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = logRef.current;
      if (
        pointerScrollingRef.current &&
        element &&
        element.scrollTop !== pointerStartScrollTopRef.current
      ) {
        if (isScrolledNearBottom(element)) {
          pinnedRef.current = true;
        } else {
          detachFromBottom();
        }
      }
      pointerScrollingRef.current = false;
      event.stopPropagation();
    },
    [detachFromBottom, logRef, pinnedRef],
  );

  return { handleOverlayPointerEndCapture, handleOverlayPointerStartCapture };
}

function isScrolledNearBottom(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    BOTTOM_TOLERANCE_PX
  );
}

function isUpwardScrollKey(
  event: React.KeyboardEvent<HTMLDivElement>,
): boolean {
  return (
    event.key === "ArrowUp" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    (event.key === " " && event.shiftKey)
  );
}
