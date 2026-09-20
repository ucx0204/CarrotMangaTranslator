import type { AppOperationActivityEvent } from "../../../shared/appOperationTypes";
import { isAppOperationActive } from "../lib/appOperationPresentation";
import { resolveAnimationFrameScheduler } from "./jobEventUtils";

/** Keep ownership transitions immediate; only redundant progress waits for paint. */
export function createAppOperationEventScheduler(
  apply: (event: AppOperationActivityEvent, announce: boolean) => void,
  finished: Set<string>,
) {
  const scheduler = resolveAnimationFrameScheduler();
  const latest = new Map<string, AppOperationActivityEvent>();
  const pending = new Map<string, AppOperationActivityEvent>();
  let frame: number | null = null;
  let disposed = false;
  const flush = (): void => {
    frame = null;
    const events = [...pending.values()];
    pending.clear();
    for (const event of events) apply(event, true);
  };
  return {
    enqueue(event: AppOperationActivityEvent, announce: boolean): void {
      if (disposed || finished.has(event.id)) return;
      const previous = latest.get(event.id);
      if (previous && previous.updatedAt > event.updatedAt) return;
      latest.set(event.id, event);
      const terminal = !isAppOperationActive(event);
      if (terminal) {
        finished.add(event.id);
        latest.delete(event.id);
      }
      const immediate =
        !announce || terminal || isOwnershipTransition(previous, event);
      if (immediate) {
        pending.delete(event.id);
        if (pending.size === 0 && frame !== null) {
          scheduler.cancelFrame(frame);
          frame = null;
        }
        apply(event, announce);
      } else {
        pending.set(event.id, event);
        frame ??= scheduler.requestFrame(flush);
      }
    },
    dispose(): void {
      disposed = true;
      if (frame !== null) scheduler.cancelFrame(frame);
      pending.clear();
      latest.clear();
    },
  };
}

function isOwnershipTransition(
  previous: AppOperationActivityEvent | undefined,
  event: AppOperationActivityEvent,
): boolean {
  return (
    !previous ||
    previous.status !== event.status ||
    previous.phase !== event.phase ||
    previous.cancellable !== event.cancellable ||
    previous.waitingForUser !== event.waitingForUser
  );
}
