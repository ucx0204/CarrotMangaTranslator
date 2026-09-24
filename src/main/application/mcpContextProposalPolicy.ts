import { randomUUID } from "node:crypto";
import type { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  mcpContextOutputSchemas,
  mcpContextRevision,
  type McpContextApplySchema,
  type McpContextPreview,
  type McpContextChangeSummary,
} from "../../shared/mcpContextEditing";
import {
  assertContextTarget,
  planMcpContextChanges,
  type McpContextPlanOptions,
  type McpContextSnapshot,
} from "./mcpContextEditPolicy";
import { McpEditError } from "./mcpEditPolicy";

type Receipt = z.infer<
  typeof mcpContextOutputSchemas.carrot_apply_context_proposal
>;
type Metadata = z.infer<
  typeof mcpContextOutputSchemas.carrot_preview_context_edit
>;
type Apply = z.infer<typeof McpContextApplySchema>;
type ContextProposalEvidence = Array<
  Pick<McpContextChangeSummary, "changeId" | "reason" | "sources">
>;
export type ContextProposalEntry = {
  owner: string;
  fingerprint: string;
  request: McpContextPreview;
  metadata: Metadata;
  changes: McpContextChangeSummary[];
  options: McpContextPlanOptions;
  applied?: Receipt;
};

/** Existing deterministic review policy, reusable without rerunning research. */
export function createContextProposal(
  snapshot: McpContextSnapshot,
  owner: string,
  request: McpContextPreview,
  source: Metadata["source"],
  evidence: ContextProposalEvidence,
  warnings: string[],
  fingerprint: string,
  clock: number,
  ttl: number,
): ContextProposalEntry {
  const now = proposalTimestamp(snapshot, clock);
  const options: McpContextPlanOptions = {
    now,
    entryIds: {},
    origin: source === "edit" ? "manual" : "ai",
  };
  const plan = planMcpContextChanges(snapshot, request, options);
  const changes = plan.changes.map((change) => ({
    ...change,
    ...evidence.find((item) => item.changeId === change.changeId),
  }));
  if (Buffer.byteLength(JSON.stringify(changes), "utf8") > 256 * 1024)
    throw new McpEditError(
      "invalid_edit",
      "Proposal is too large; split it into smaller explicit reviews.",
    );
  const metadata = mcpContextOutputSchemas.carrot_preview_context_edit.parse({
    proposalId: randomUUID(),
    chapterId: request.chapterId,
    workId: snapshot.workId,
    revision: request.revision,
    source,
    changeIds: changes.map((item) => item.changeId),
    expiresAt: clock + ttl,
    warnings,
  });

  return {
    owner,
    fingerprint,
    request: structuredClone(request),
    metadata,
    changes,
    options,
  };
}

export function selectContextProposal(
  entry: ContextProposalEntry,
  request: Apply,
) {
  if (entry.applied)
    throw new McpEditError(
      "invalid_edit",
      "This proposal was already applied. Create a new preview for further changes.",
    );
  const selected = new Set(request.selectedChangeIds);
  if (
    selected.size !== request.selectedChangeIds.length ||
    [...selected].some((id) => !entry.metadata.changeIds.includes(id))
  )
    throw new McpEditError(
      "invalid_edit",
      "Select distinct change IDs from this proposal.",
    );
  const subset = {
    ...entry.request,
    changes: entry.request.changes.filter((item) =>
      selected.has(item.changeId),
    ),
  };

  return subset;
}

export function buildContextProposalCommit(
  current: McpContextSnapshot,
  entry: ContextProposalEntry,
  subset: McpContextPreview,
  request: Apply,
  clock: number,
  check: () => void,
) {
  check();
  assertContextTarget(
    current,
    entry.request.chapterId,
    entry.metadata.revision,
  );
  const plan = planMcpContextChanges(current, subset, {
    ...entry.options,
    now: proposalTimestamp(current, clock),
  });
  assertReviewedChanges(plan.changes, entry.changes);
  return {
    ...(plan.guideChanged ? { styleGuide: plan.styleGuide } : {}),
    ...(plan.memoryChanged ? { storyMemory: plan.storyMemory } : {}),
    result: mcpContextOutputSchemas.carrot_apply_context_proposal.parse({
      proposalId: request.proposalId,
      requestId: request.requestId,
      status: "applied",
      previousRevision: entry.metadata.revision,
      revision: mcpContextRevision({
        ...current,
        styleGuide: plan.styleGuide,
        storyMemory: plan.storyMemory,
      }),
      changesApplied: plan.changes.filter((item) => item.changed).length,
      selectedChangeIds: request.selectedChangeIds,
      pagesChanged: 0,
      note: "Only selected context fields were applied. Translations, images and page blocks were not changed. Receipt revision is historical; read current context before another edit.",
    }),
  };
}

function assertReviewedChanges(
  actual: McpContextChangeSummary[],
  expected: McpContextChangeSummary[],
): void {
  for (const change of actual) {
    const reviewed = expected.find((item) => item.changeId === change.changeId);
    if (
      !reviewed ||
      hashStableValue([change.before, reviewableFields(change.after)]) !==
        hashStableValue([reviewed.before, reviewableFields(reviewed.after)])
    )
      throw new McpEditError(
        "revision_conflict",
        "The selected context change no longer matches its reviewed result.",
      );
  }
}

function proposalTimestamp(snapshot: McpContextSnapshot, now: number): string {
  const timestamps = [
    snapshot.styleGuide.updatedAt,
    snapshot.storyMemory.updatedAt,
  ]
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .map((value) => value + 1);
  return new Date(Math.max(now, ...timestamps)).toISOString();
}

// Audit timestamps describe publication time, not the content a user approved.
function reviewableFields(value: McpContextChangeSummary["after"]) {
  const { createdAt: _created, updatedAt: _updated, ...fields } = value;
  return fields;
}
