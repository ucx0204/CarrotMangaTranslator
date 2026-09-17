import { readWorkContextForEdit } from "../library";
import { retainLibrarySnapshot, withLibraryRead } from "../library/lock";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import { logError } from "../logger";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpPageEditService } from "../application/mcpPageEditService";
import type { BatchTextCommit } from "../application/mcpTranslationBatchRunner";

/** The inner scope runs after page handoff. It never waits for context while
 * owning the page; a competing writer fails this page rather than deadlocking.
 * retainLibrarySnapshot preserves the current page activity owner. */
export function createMcpTranslationBatchPorts(edits: McpPageEditService) {
  const commit: BatchTextCommit = async (
    request,
    expected,
    guard,
    onCommitted,
  ) => {
    await edits.commitTranslationBatch(
      request,
      expected.membership,
      guard,
      onCommitted,
      async (run) => {
        const release = await withLibraryRead(async () =>
          retainLibrarySnapshot(
            [{ kind: "work-context", scope: expected.workId, access: "read" }],
            [],
          ),
        );
        try {
          guard();
          const saved = await readWorkContextForEdit(request.chapterId);
          guard();
          if (
            saved.workId !== expected.workId ||
            (expected.contextRevision !== null &&
              mcpContextRevision(saved) !== expected.contextRevision)
          )
            throw new McpEditError(
              "revision_conflict",
              "Saved context changed. Re-read context and prepare a new plan for remaining pages.",
            );
          return await run();
        } finally {
          release();
        }
      },
    );
  };
  return {
    read: readWorkContextForEdit,
    commit,
    reportError: (error: unknown) =>
      logError("MCP translation batch stopped", error),
  };
}
