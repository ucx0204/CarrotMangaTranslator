import type { McpContextPreview } from "../../shared/mcpContextEditing";
import { libraryStructureResource, pageContentResource } from "../../shared/appActivityTypes";
import { withLibraryContentEdit } from "../library/lock";

/** Shared activity ownership protects context edits from UI writes and shutdown.
 * A disconnected synchronous caller cannot leave a pending write behind. */
export async function withMcpContextEditScope<T>(
  target: { chapterId: string; workId: string }, request: McpContextPreview,
  lifetime: AbortSignal, authorize: () => void, run: () => Promise<T>,
): Promise<T> {
  authorize();
  const cancelled = new AbortController();
  const signal = AbortSignal.any([lifetime, cancelled.signal]);
  const monitor = setInterval(() => {
    try { authorize(); } catch (error) { cancelled.abort(error); }
  }, 250);
  monitor.unref();
  try {
    return await withLibraryContentEdit([
      { kind: "work-context", scope: target.workId, access: "write" },
      libraryStructureResource("chapter", target.chapterId, "read"),
      ...request.changes.flatMap((change) => change.entity === "memory"
        ? [{ ...pageContentResource(target.chapterId, change.pageId), access: "read" as const }] : []),
    ], async () => { signal.throwIfAborted(); authorize(); return run(); }, signal);
  } finally { clearInterval(monitor); }
}
