import { z } from "zod/v4";
import {
  McpContextApplySchema,
  McpContextPreviewSchema,
  McpContextResearchTargetSchema,
  mcpContextOutputSchemas,
  type McpContextChangeSummary,
  type McpContextPreview,
} from "../../shared/mcpContextEditing";

const fingerprint = z.string().regex(/^[a-f0-9]{16}$/);
const metadata = mcpContextOutputSchemas.carrot_preview_context_research.extend(
  {
    source: z.enum(["external-research", "app-research"]),
    retention: z.literal("seven-days"),
  },
);
const research = z
  .object({
    target: McpContextResearchTargetSchema,
    referenceSnapshot: fingerprint.optional(),
    queryCount: z.number().int().nonnegative(),
    sourceCount: z.number().int().nonnegative(),
    tavilyCreditsUsed: z.number().nonnegative(),
  })
  .strict();
export type McpResearchPreparation = {
  request: McpContextPreview;
  source: "external-research" | "app-research";
  evidence: Array<
    Pick<McpContextChangeSummary, "changeId" | "reason" | "sources">
  >;
  warnings: string[];
  research?: z.infer<typeof research>;
};

const recordSchema = z
  .object({
    format: z.literal(1),
    owner: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    fingerprint,
    createdAt: z.number().int().nonnegative(),
    referenceSnapshot: fingerprint,
    request: McpContextPreviewSchema,
    metadata,
    changes: z
      .array(
        mcpContextOutputSchemas.carrot_get_context_proposal.shape.changes
          .element,
      )
      .min(1)
      .max(100),
    options: z
      .object({
        now: z.string().datetime(),
        origin: z.literal("ai"),
        entryIds: z
          .array(
            z.tuple([
              z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
              z.string().uuid(),
            ]),
          )
          .max(100),
      })
      .strict(),
    research: research.optional(),
    applied: z
      .object({
        input: McpContextApplySchema,
        receipt: mcpContextOutputSchemas.carrot_apply_context_proposal,
        recoveryId: z.string().uuid(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RetainedResearchProposal = z.infer<typeof recordSchema>;
type Record = RetainedResearchProposal;

/** Private native state. No MCP input accepts serialized reviews or callbacks. */
export const RetainedResearchProposalSchema = recordSchema.superRefine(
  (record, context) => {
    if (!consistentTargets(record) || !consistentChanges(record))
      context.addIssue({
        code: "custom",
        message: "Inconsistent retained research review.",
      });
    if (!consistentApplication(record))
      context.addIssue({
        code: "custom",
        message: "Inconsistent applied research receipt.",
      });
    if (!consistentResearch(record))
      context.addIssue({
        code: "custom",
        message: "Research provenance belongs to another request.",
      });
  },
);

function consistentTargets(record: Record) {
  return (
    record.request.chapterId === record.metadata.chapterId &&
    record.request.revision === record.metadata.revision &&
    record.metadata.expiresAt > record.createdAt &&
    record.request.changes.every((change) =>
      ["glossary", "character"].includes(change.entity),
    ) &&
    record.changes.every((change) =>
      ["glossary", "character"].includes(change.entity),
    )
  );
}
function consistentChanges(record: Record) {
  const ids = record.request.changes.map((change) => change.changeId);
  const keys = record.options.entryIds.map(([key]) => key);
  return (
    new Set(ids).size === ids.length &&
    new Set(keys).size === keys.length &&
    JSON.stringify(ids) === JSON.stringify(record.metadata.changeIds) &&
    JSON.stringify(ids) ===
      JSON.stringify(record.changes.map((change) => change.changeId)) &&
    record.options.entryIds.every(([key, id]) =>
      record.changes.some(
        (change) => change.changeId === key && change.targetId === id,
      ),
    )
  );
}
function consistentApplication(record: Record) {
  const applied = record.applied;
  if (!applied) return true;
  return (
    applied.input.proposalId === record.metadata.proposalId &&
    applied.receipt.proposalId === record.metadata.proposalId &&
    applied.input.requestId === applied.receipt.requestId &&
    applied.receipt.recoveryId === applied.recoveryId &&
    new Set(applied.input.selectedChangeIds).size ===
      applied.input.selectedChangeIds.length &&
    JSON.stringify(applied.input.selectedChangeIds) ===
      JSON.stringify(applied.receipt.selectedChangeIds) &&
    applied.input.selectedChangeIds.every((id) =>
      record.metadata.changeIds.includes(id),
    )
  );
}
function consistentResearch(record: Record) {
  const details = record.research;
  if (!details) return true;
  return (
    record.metadata.source === "app-research" &&
    details.target.chapterId === record.request.chapterId &&
    details.target.revision === record.request.revision &&
    details.target.requestId === record.request.requestId &&
    (details.referenceSnapshot === undefined ||
      details.referenceSnapshot === record.referenceSnapshot)
  );
}
