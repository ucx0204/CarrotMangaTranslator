import type { z } from "zod/v4";
import type { McpContextApplySchema } from "../../shared/mcpContextEditing";
import type { McpContextReferenceSnapshot } from "../../shared/mcpContextReferences";
import type { ContextMigrationDelta } from "../../shared/mcpContextMigrationState";
import type { RetainedResearchProposal } from "./mcpResearchProposalState";
import { contextMigrationSnapshot } from "./mcpContextMigrationPolicy";
import {
  selectContextProposal,
  buildContextProposalCommit,
} from "./mcpContextProposalPolicy";
import { McpEditError } from "./mcpEditPolicy";

type Graph = McpContextReferenceSnapshot;

export function researchContextSnapshot(graph: Graph, chapterId: string) {
  const anchor = graph.chapters.find((item) => item.chapter.id === chapterId);
  if (!anchor)
    throw new McpEditError(
      "not_found",
      "Research anchor chapter no longer exists.",
    );
  return {
    workId: graph.workId,
    workTitle: graph.workTitle,
    styleGuide: graph.styleGuide,
    ...anchor,
  };
}

/** Reuses the original partial editor; no raw transport snapshot is accepted. */
export function prepareRetainedResearchApplication(
  graph: Graph,
  record: RetainedResearchProposal,
  input: z.infer<typeof McpContextApplySchema>,
  now: string,
  guard: () => void,
) {
  guard();
  const beforeSnapshot = contextMigrationSnapshot(
    graph,
    record.request.chapterId,
    guard,
  ).snapshot;
  if (
    graph.workId !== record.metadata.workId ||
    beforeSnapshot !== record.referenceSnapshot
  )
    throw new McpEditError(
      "revision_conflict",
      "Saved work changed after research review. Prepare a new review; no forced overwrite.",
    );
  const entry = {
    ...record,
    options: {
      ...record.options,
      entryIds: Object.fromEntries(record.options.entryIds),
    },
    applied: record.applied?.receipt,
  };
  const subset = selectContextProposal(entry, input);
  const commit = buildContextProposalCommit(
    researchContextSnapshot(graph, record.request.chapterId),
    entry,
    subset,
    input,
    Date.parse(now),
    guard,
  );
  const delta: ContextMigrationDelta = {
    pages: [],
    memories: [],
    ...(commit.styleGuide
      ? { guide: { before: graph.styleGuide, after: commit.styleGuide } }
      : {}),
  };
  const afterSnapshot = contextMigrationSnapshot(
    { ...graph, styleGuide: commit.styleGuide ?? graph.styleGuide },
    record.request.chapterId,
    guard,
  ).snapshot;
  return { delta, beforeSnapshot, afterSnapshot, receipt: commit.result };
}
