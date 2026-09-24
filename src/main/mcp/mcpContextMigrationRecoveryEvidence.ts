import type { McpContextReferenceSnapshot } from "../../shared/mcpContextReferences";
import type { RetainedContextMigration } from "../../shared/mcpContextMigrationState";
import { contextMigrationSnapshot } from "../application/mcpContextMigrationPolicy";
import { projectContextMigrationRecovery } from "../application/mcpContextMigrationRecoveryPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { contextMigrationState } from "./mcpContextMigrationRepository";
type Graph = McpContextReferenceSnapshot;

export function checkRecoveryState(
  graph: Graph,
  record: RetainedContextMigration,
  snapshot: string,
  direction: "undo" | "redo",
  guard: () => void,
) {
  const current = contextMigrationSnapshot(
    graph,
    record.anchorChapterId,
    guard,
  ).snapshot;
  const state = contextMigrationState(record);
  if (
    graph.workId !== record.workId ||
    snapshot !== current ||
    current !== state.expected
  )
    throw new McpEditError(
      "revision_conflict",
      "Work context, membership or a saved page changed after this migration.",
    );
  if (!state.room || !state.changed || state.applied !== (direction === "undo"))
    throw new McpEditError(
      "invalid_edit",
      "Context recovery direction is unavailable or its action history is full.",
    );
}

export function recoveryTarget(
  graph: Graph,
  record: RetainedContextMigration,
  reference: string,
  direction: "undo" | "redo",
  guidePresent: boolean,
  memoryPresence: ReadonlyMap<string, boolean>,
  guard: () => void,
) {
  checkRecoveryState(graph, record, reference, direction, guard);
  const mismatch = contextMigrationPresenceMismatch(
    record,
    guidePresent,
    memoryPresence,
    direction === "undo",
  );
  if (mismatch) throw new McpEditError("revision_conflict", mismatch);
  const next = projectContextMigrationRecovery(graph, record.delta, direction);
  const snapshot = contextMigrationSnapshot(
    next,
    record.anchorChapterId,
    guard,
  ).snapshot;
  const expected =
    direction === "undo" ? record.beforeSnapshot : record.afterSnapshot;
  if (snapshot !== expected)
    throw new McpEditError(
      "invalid_edit",
      "Retained context recovery does not reproduce the exact recorded state.",
    );
  return snapshot;
}

/** Same native file-presence authority for availability inspection and publication. */
export function contextMigrationPresenceMismatch(
  record: RetainedContextMigration,
  guidePresent: boolean,
  memoryPresence: ReadonlyMap<string, boolean>,
  applied: boolean,
) {
  if (
    record.delta.guide &&
    guidePresent !== (applied || record.guideBeforePresent)
  )
    return "Context catalog file presence changed.";
  if (
    record.delta.memories.some(
      (memory) =>
        memory.beforePresent !== undefined &&
        memoryPresence.get(memory.chapterId) !==
          (applied || memory.beforePresent),
    )
  )
    return "Memory file presence changed after refresh.";
  return null;
}
