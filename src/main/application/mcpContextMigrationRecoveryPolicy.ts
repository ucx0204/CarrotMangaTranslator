import { hashStableValue } from "../../shared/blockFingerprint";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import {
  ContextMigrationDeltaSchema,
  contextBlockReferences,
  restoreContextBlockReferences,
  type ContextMigrationDelta,
} from "../../shared/mcpContextMigrationState";
import type { McpContextReferenceSnapshot } from "../../shared/mcpContextReferences";
import { McpEditError } from "./mcpEditPolicy";

type Graph = McpContextReferenceSnapshot;

/** Apply only an internally computed/retained delta; ordinary texts and pixels stay intact. */
export function projectContextMigrationRecovery(
  graph: Graph,
  input: ContextMigrationDelta,
  direction: "apply" | "undo" | "redo",
): Graph {
  const delta = ContextMigrationDeltaSchema.parse(input);
  const next = structuredClone(graph);
  const target = direction === "undo" ? "before" : "after";
  const expected = direction === "undo" ? "after" : "before";
  if (delta.guide) {
    if (
      delta.guide.before.workId !== graph.workId ||
      delta.guide.after.workId !== graph.workId
    )
      throw new McpEditError(
        "invalid_edit",
        "Context recovery cannot move a catalog to another work.",
      );
    next.styleGuide = structuredClone(delta.guide[target]);
  }
  recoverMemories(next, graph, delta, target, expected);
  recoverReferences(next, delta, target, expected);
  return next;
}

function recoverMemories(
  next: Graph,
  graph: Graph,
  delta: ContextMigrationDelta,
  target: "before" | "after",
  expected: "before" | "after",
) {
  for (const memory of delta.memories) {
    const chapter = next.chapters.find(
      (item) => item.chapter.id === memory.chapterId,
    );
    if (
      !chapter ||
      memory.before.workId !== graph.workId ||
      memory.after.workId !== graph.workId ||
      memory.before.chapterId !== memory.chapterId ||
      memory.after.chapterId !== memory.chapterId
    )
      throw new McpEditError(
        "invalid_edit",
        "Context recovery memory membership is invalid.",
      );
    const basis = { ...graph, storyMemory: chapter.storyMemory };
    if (
      mcpContextRevision(basis) !==
      mcpContextRevision({ ...basis, storyMemory: memory[expected] })
    )
      throw new McpEditError(
        "revision_conflict",
        "Context recovery memory changed after this record.",
      );
    chapter.storyMemory = structuredClone(memory[target]);
  }
}

function recoverReferences(
  next: Graph,
  delta: ContextMigrationDelta,
  target: "before" | "after",
  expected: "before" | "after",
) {
  for (const change of delta.pages) {
    const chapter = next.chapters.find(
      (item) => item.chapter.id === change.chapterId,
    );
    const page = chapter?.chapter.pages.find(
      (item) => item.id === change.pageId,
    );
    if (!page)
      throw new McpEditError(
        "not_found",
        "A context recovery page no longer belongs to the work.",
      );
    for (const patch of change.blocks) {
      const index = page.blocks.findIndex(
        (block) => block.id === patch.blockId,
      );
      if (index < 0)
        throw new McpEditError(
          "not_found",
          "A referenced block no longer exists.",
        );
      if (
        hashStableValue(contextBlockReferences(page.blocks[index])) !==
        hashStableValue(patch[expected])
      )
        throw new McpEditError(
          "revision_conflict",
          "Block references changed after this context record.",
        );
      page.blocks[index] = restoreContextBlockReferences(
        page.blocks[index],
        patch[target],
      );
    }
  }
}
