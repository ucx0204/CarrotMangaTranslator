import { z } from "zod/v4";
import { McpContextResearchTargetSchema } from "./mcpContextEditing";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const fingerprint = z.string().regex(/^[a-f0-9]{16}$/);
const count = z.number().int().nonnegative();
export const McpResearchWorkSchema = McpContextResearchTargetSchema.omit({
  requestId: true,
})
  .extend({
    workId: id,
    referenceSnapshot: fingerprint,
    titleConfirmed: z.boolean().default(false),
    allowSpoilers: z.boolean().default(false),
  })
  .strict();
export type McpResearchWork = z.infer<typeof McpResearchWorkSchema>;
export const McpResearchBatchPrepareSchema = z
  .object({
    requestId: z.uuid(),
    works: z.array(McpResearchWorkSchema).min(1).max(10),
    maxAttempts: count.min(1).max(30).default(10),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      new Set(input.works.map((work) => work.workId)).size !==
      input.works.length
    )
      ctx.addIssue({ code: "custom", message: "Select each work only once." });
    if (
      new Set(input.works.map((work) => work.chapterId)).size !==
      input.works.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Use one distinct anchor chapter per work.",
      });
  });
export type McpResearchBatchPrepare = z.infer<
  typeof McpResearchBatchPrepareSchema
>;
export const McpResearchBatchGetSchema = z.object({ id: z.uuid() }).strict();
const action = McpResearchBatchGetSchema.extend({
  version: count,
  requestId: z.uuid(),
});
export const McpResearchBatchRunSchema = action
  .extend({
    retryFailed: z.boolean().default(false),
    allowExternal: z.literal(true),
    allowAssetDownloads: z.boolean().default(false),
  })
  .strict();
export type McpResearchBatchRun = z.infer<typeof McpResearchBatchRunSchema>;
export const McpResearchBatchResolveSchema = action
  .extend({
    workId: id,
    researchTitle: McpContextResearchTargetSchema.shape.researchTitle,
    titleConfirmed: z.literal(true),
    allowSpoilers: z.literal(true),
  })
  .strict();
export type McpResearchBatchResolve = z.infer<
  typeof McpResearchBatchResolveSchema
>;
export const McpResearchBatchDiscardSchema = McpResearchBatchGetSchema.extend({
  confirm: z.literal(true),
}).strict();
export const McpResearchBatchUsageSchema = z
  .object({
    queryCount: count,
    sourceCount: count,
    tavilyCreditsUsed: z.number().nonnegative(),
  })
  .strict();
const outcome = z.enum(["proposed", "no_changes", "failed", "interrupted"]);
export const McpResearchBatchAttemptSchema = z
  .object({
    requestId: z.uuid(),
    jobId: z.uuid().nullable(),
    status: z.enum(["running", ...outcome.options]),
    proposalId: z.uuid().nullable(),
    usage: McpResearchBatchUsageSchema.nullable(),
    errorCode: z.string().max(100).nullable(),
  })
  .strict();
const item = z
  .object({
    workId: id,
    chapterId: id,
    researchTitle: McpContextResearchTargetSchema.shape.researchTitle,
    engine: McpContextResearchTargetSchema.shape.engine,
    status: z.enum(["pending", "held", "running", ...outcome.options]),
    holds: z.array(z.enum(["title_unconfirmed", "spoiler_scope"])).max(2),
    attempts: z.array(McpResearchBatchAttemptSchema).max(30),
  })
  .strict();
const view = z
  .object({
    id: z.uuid(),
    version: count,
    createdAt: count,
    expiresAt: count,
    status: z.enum([
      "prepared",
      "running",
      "paused",
      "cancelled",
      "partial",
      "completed",
      "interrupted",
      "failed",
    ]),
    errorCode: z.string().max(100).nullable(),
    pauseRequested: z.boolean(),
    cancellationRequested: z.boolean(),
    maxAttempts: count,
    attemptsUsed: count,
    usage: McpResearchBatchUsageSchema,
    unknownUsageAttempts: count,
    works: z.array(item).min(1).max(10),
    warnings: z.array(z.string().max(300)).max(10),
    retention: z.literal(
      "seven-days; same-profile-and-owner; no-automatic-reexecution",
    ),
  })
  .strict();
export const mcpResearchBatchOutputs = {
  carrot_prepare_research_batch: view,
  carrot_get_research_batch: view,
  carrot_run_research_batch: view,
  carrot_resolve_research_hold: view,
  carrot_pause_research_batch: view,
  carrot_cancel_research_batch: view,
  carrot_list_research_batches: z
    .object({
      total: count,
      offset: count,
      limit: count,
      nextOffset: count.nullable(),
      snapshot: fingerprint,
      items: z.array(view.omit({ works: true })).max(25),
    })
    .strict(),
  carrot_discard_research_batch: z
    .object({
      id: z.uuid(),
      status: z.literal("discarded"),
      pageChanges: z.literal(0),
    })
    .strict(),
};
