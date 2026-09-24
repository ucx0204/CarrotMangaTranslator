import { readWorkContextForEdit } from "../library";
import { retainLibrarySnapshot, withLibraryRead } from "../library/lock";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import type { McpTranslationPatch } from "../../shared/mcpEditingTypes";
import { logError } from "../logger";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpPageEditService } from "../application/mcpPageEditService";
import type { FormatSnapshotRequest } from "../application/mcpFormatBatchPolicy";
import type { BatchCommit, BatchPorts } from "../application/mcpPageBatchTypes";

type Scope = <T>(run: () => Promise<T>) => Promise<T>;
export function createMcpTranslationBatchPorts(edits: McpPageEditService) {
  return createMcpPageBatchPorts<McpTranslationPatch>(
    (request, membership, guard, onCommitted, scope) =>
      edits.commitTranslationBatch(
        request,
        membership,
        guard,
        onCommitted,
        scope,
      ),
  );
}
export function createMcpFormatBatchPorts(edits: McpPageEditService) {
  return createMcpPageBatchPorts<FormatSnapshotRequest>(
    (request, membership, guard, onCommitted, scope) =>
      edits.commitFormatBatch(request, membership, guard, onCommitted, scope),
  );
}
/** Context is acquired after page handoff. Existing nonwaiting read lease preserves
 * the page owner; shared here to keep format/text deadlock and authorization rules identical. */
export function createMcpPageBatchPorts<R extends { chapterId: string }>(
  save: (
    request: R,
    membership: string,
    guard: () => void,
    onCommitted: Parameters<BatchCommit<R>>[3],
    scope: Scope,
  ) => Promise<void>,
): BatchPorts<R> {
  const commit: BatchCommit<R> = async (
    request,
    expected,
    guard,
    onCommitted,
  ) => {
    await save(
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
    reportError: (error) => logError("MCP page batch stopped", error),
  };
}
