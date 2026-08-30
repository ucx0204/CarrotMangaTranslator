import type {
  PageProcessingTimingState,
  PageTimingSessionRef,
} from "../../../shared/pageProcessingTiming";

export function createRendererPageTimingSession(
  startedAtEpochMs = Date.now(),
): PageTimingSessionRef {
  return { id: crypto.randomUUID(), startedAtEpochMs };
}

export async function finishRendererPageTimingSession(
  chapterId: string,
  session: PageTimingSessionRef,
  state: Exclude<PageProcessingTimingState, "running">,
): Promise<boolean> {
  const finishSession =
    typeof window === "undefined"
      ? undefined
      : window.mangaApi?.finishPageTimingSession;
  if (!finishSession) return false;
  try {
    const result = await finishSession({
      chapterId,
      sessionId: session.id,
      elapsedMs: Math.max(0, Date.now() - session.startedAtEpochMs),
      state,
    });
    return result.updated;
  } catch (error) {
    console.error("Failed to finalize page timing session", error);
    return false;
  }
}
