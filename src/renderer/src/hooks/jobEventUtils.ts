import type { JobEvent } from "../../../shared/jobTypes";

export function resolveAnimationFrameScheduler(): {
  cancelFrame: (frameId: number) => void;
  requestFrame: (callback: FrameRequestCallback) => number;
} {
  return {
    requestFrame:
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (callback) => window.setTimeout(() => callback(performance.now()), 0),
    cancelFrame:
      typeof window.cancelAnimationFrame === "function"
        ? window.cancelAnimationFrame.bind(window)
        : window.clearTimeout.bind(window),
  };
}

export function shouldRefreshLiveChapter(event: JobEvent): boolean {
  return (
    event.phase === "page_done" ||
    event.phase === "page_skipped" ||
    event.phase === "inpainting_done"
  );
}

export function isLogOnlyEvent(event: JobEvent): boolean {
  return Boolean(event.installLogLine && event.progressMode === "log-only");
}
