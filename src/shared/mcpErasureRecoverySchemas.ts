import { z } from "zod/v4";

const revision = z.string().regex(/^page-v1:[a-f0-9]{16}$/);
const target = z
  .object({ chapterId: z.string(), pageId: z.string(), blockId: z.string() })
  .strict();
export const mcpErasureRecoveryLookup = z
  .object({ jobId: z.string().uuid() })
  .strict();
export const mcpErasureRecoveryAction = mcpErasureRecoveryLookup
  .extend({
    revision,
    requestId: z.string().uuid(),
  })
  .strict();
const view = z
  .object({
    jobId: z.string().uuid(),
    target: target.optional(),
    state: z.enum(["applied", "undone", "conflict", "unavailable"]),
    reason: z.enum([
      "ready",
      "history_unavailable",
      "page_changed",
      "artifact_missing",
      "not_selected_erasure",
      "job_not_completed",
    ]),
    revision: revision.optional(),
    sessionOnly: z.literal(true),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
  })
  .strict();
const receipt = z
  .object({
    jobId: z.string().uuid(),
    requestId: z.string().uuid(),
    direction: z.enum(["undo", "redo"]),
    target,
    status: z.enum(["applied", "already_applied"]),
    revision,
    pagesChanged: z.number().int().min(0).max(1),
  })
  .strict();
export const mcpErasureRecoveryOutputs = {
  carrot_get_erasure_recovery: view,
  carrot_undo_erasure: receipt,
  carrot_redo_erasure: receipt,
};
