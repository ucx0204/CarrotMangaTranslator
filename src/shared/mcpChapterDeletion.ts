import { z } from "zod/v4";
import {
  McpImportTargetSchema,
  McpImportCreateSchema,
} from "./mcpLibraryImport";
import { McpRetainedGetSchema, mcpRetentionOutputs } from "./mcpRetention";

const id = McpImportTargetSchema.shape.workId;
const hash = McpImportCreateSchema.shape.snapshot;
const count = z.number().int().nonnegative();
export const MCP_CHAPTER_DELETION_BYTES = 256 * 1024 * 1024;
export const MCP_CHAPTER_DELETION_ENTRIES = 2000;
export const McpChapterDeletionTargetSchema = z
  .object({ workId: id, chapterId: id })
  .strict();
export const McpChapterDeletionApplySchema =
  McpChapterDeletionTargetSchema.extend({
    requestId: z.uuid(),
    snapshot: hash,
    confirm: z.literal("delete-chapter-with-seven-day-recovery"),
  }).strict();
export const McpChapterDeletionRecoverySchema = McpRetainedGetSchema.extend({
  requestId: z.uuid(),
  snapshot: hash,
  confirm: z.literal(true),
}).strict();
export type McpChapterDeletionTarget = z.infer<
  typeof McpChapterDeletionTargetSchema
>;
export type McpChapterDeletionRecovery = z.infer<
  typeof McpChapterDeletionRecoverySchema
>;
const summary = McpChapterDeletionTargetSchema.extend({
  workTitle: z.string().max(4096),
  chapterTitle: z.string().max(4096),
  pageCount: count.max(50),
  fileCount: count.max(MCP_CHAPTER_DELETION_ENTRIES),
  directoryCount: count.max(MCP_CHAPTER_DELETION_ENTRIES),
  sourceBytes: count.max(MCP_CHAPTER_DELETION_BYTES),
}).strict();
const receipt = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    workId: id,
    chapterId: id,
    direction: z.enum(["delete", "undo", "redo"]),
    status: z.enum(["saved", "already_applied"]),
    historical: z.boolean(),
    snapshot: hash,
    expiresAt: count,
    warnings: z.array(z.string().max(1000)).max(10),
  })
  .strict();
const catalog = mcpRetentionOutputs.carrot_list_changes;
export const mcpChapterDeletionOutputs = {
  carrot_preview_chapter_deletion: summary
    .extend({
      snapshot: hash,
      recovery: z.literal("seven-days-then-recovery-may-be-permanently-pruned"),
      warnings: z.array(z.string().max(1000)).max(10),
    })
    .strict(),
  carrot_delete_chapter: receipt,
  carrot_undo_chapter_deletion: receipt,
  carrot_redo_chapter_deletion: receipt,
  carrot_get_chapter_deletion: summary
    .extend({
      id: z.uuid(),
      createdAt: count,
      expiresAt: count,
      snapshot: hash,
      deleted: z.boolean(),
      actionsUsed: count.max(32),
      canUndo: z.boolean(),
      canRedo: z.boolean(),
      warnings: z.array(z.string().max(1000)).max(10),
    })
    .strict(),
  carrot_list_chapter_deletions: catalog.extend({
    items: z
      .array(
        catalog.shape.items.element.extend({
          kind: z.literal("chapter-deletion"),
          pageCount: count.max(50),
          mimeType: z.null(),
          sha256: z.null(),
        }),
      )
      .max(25),
  }),
  carrot_discard_chapter_deletion: z
    .object({
      id: z.uuid(),
      status: z.literal("discarded"),
      chapterChanges: z.literal(0),
    })
    .strict(),
};
