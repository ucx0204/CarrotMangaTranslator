const PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_PREVIEW_SESSIONS = 20;

export function prunePreviewSessions<T>(
  sessions: Map<string, T & { createdAt: number }>,
): void {
  const now = Date.now();
  for (const [previewId, session] of sessions) {
    if (now - session.createdAt > PREVIEW_SESSION_TTL_MS) {
      sessions.delete(previewId);
    }
  }
  while (sessions.size > MAX_PREVIEW_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (!oldest) {
      break;
    }
    sessions.delete(oldest);
  }
}
