import { z } from "zod/v4";
import {
  McpChapterDeletionTargetSchema,
  McpChapterDeletionApplySchema,
} from "./mcpChapterDeletion";
import { mcpRetentionOutputs } from "./mcpRetention";

const id = McpChapterDeletionTargetSchema.shape.workId;
const hash = McpChapterDeletionApplySchema.shape.snapshot;
const count = z.number().int().nonnegative();
const mapping = z
  .object({
    kind: z.enum(["glossary", "character"]),
    sourceId: z.string().max(200),
    targetId: id,
  })
  .strict();
const McpChapterMoveIntentSchema = McpChapterDeletionTargetSchema.extend({
  destinationWorkId: id,
  beforeChapterId: id.optional(),
  references: z.array(mapping).max(2000).optional(),
})
  .strict()
  .refine(
    (value) => value.workId !== value.destinationWorkId,
    "Choose two distinct existing works.",
  )
  .refine((value) => {
    const keys = (value.references ?? []).map(
      (item) => `${item.kind}/${item.sourceId}`,
    );
    return new Set(keys).size === keys.length;
  }, "Reference mappings must have distinct source keys.");
export const McpChapterMovePreviewSchema = z
  .object({ intent: McpChapterMoveIntentSchema })
  .strict();
export const McpChapterMoveApplySchema = McpChapterMovePreviewSchema.extend({
  requestId: z.uuid(),
  snapshot: hash,
  planFingerprint: hash,
  confirm: z.literal("move-chapter-between-existing-works"),
}).strict();
export type McpChapterMoveIntent = z.infer<typeof McpChapterMoveIntentSchema>;
export type McpChapterMoveApply = z.infer<typeof McpChapterMoveApplySchema>;
const warnings = z.array(z.string().max(1000)).max(12);
const referenceIssue = mapping
  .pick({ kind: true, sourceId: true })
  .extend({
    reason: z.enum([
      "missing-target",
      "different-definition",
      "unused-mapping",
    ]),
  })
  .strict();
const receipt = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    chapterId: id,
    workId: id,
    destinationWorkId: id,
    direction: z.enum(["move", "undo", "redo"]),
    status: z.enum(["saved", "already_applied"]),
    historical: z.boolean(),
    snapshot: hash,
    expiresAt: count,
    warnings,
  })
  .strict();
const catalog = mcpRetentionOutputs.carrot_list_changes;
export const mcpChapterMoveOutputs = {
  carrot_preview_chapter_move: z
    .object({
      intent: McpChapterMoveIntentSchema,
      snapshot: hash,
      planFingerprint: hash,
      eligible: z.boolean(),
      sourceWorkTitle: z.string().max(4096),
      destinationWorkTitle: z.string().max(4096),
      beforeTitle: z.string().max(4096),
      afterTitle: z.string().max(4096),
      sourceChapterIds: z.array(id).max(2000),
      destinationChapterIds: z.array(id).max(2000),
      pageCount: count.max(50),
      sourceBytes: count.max(256 * 1024 * 1024),
      fileCount: count.max(2000),
      memoryPresent: z.boolean(),
      referenceIssues: z.array(referenceIssue).max(2000),
      mappedReferences: count,
      invalidatedCheckpoints: count.max(50),
      warnings,
    })
    .strict(),
  carrot_move_chapter: receipt,
  carrot_undo_chapter_move: receipt,
  carrot_redo_chapter_move: receipt,
  carrot_get_chapter_move: z
    .object({
      id: z.uuid(),
      intent: McpChapterMoveIntentSchema,
      createdAt: count,
      expiresAt: count,
      snapshot: hash,
      moved: z.boolean(),
      actionsUsed: count.max(32),
      canUndo: z.boolean(),
      canRedo: z.boolean(),
      warnings,
    })
    .strict(),
  carrot_list_chapter_moves: catalog.extend({
    items: z
      .array(
        catalog.shape.items.element.extend({
          kind: z.literal("chapter-move"),
          pageCount: count.max(50),
          mimeType: z.null(),
          sha256: z.null(),
        }),
      )
      .max(25),
  }),
};
