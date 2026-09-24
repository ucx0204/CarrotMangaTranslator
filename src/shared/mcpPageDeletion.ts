import { z } from "zod/v4";
import {
  McpChapterDeletionTargetSchema,
  McpChapterDeletionApplySchema,
  mcpChapterDeletionOutputs,
} from "./mcpChapterDeletion";

const pageId = McpChapterDeletionTargetSchema.shape.chapterId;
export const McpPageDeletionTargetSchema =
  McpChapterDeletionTargetSchema.extend({ pageId }).strict();
export const McpPageDeletionApplySchema = McpChapterDeletionApplySchema.extend({
  pageId,
  confirm: z.literal("delete-page-with-seven-day-recovery"),
}).strict();
export type McpPageDeletionTarget = z.infer<typeof McpPageDeletionTargetSchema>;
export type McpPageDeletionApply = z.infer<typeof McpPageDeletionApplySchema>;
const count = z.number().int().nonnegative();
const summary = {
  pageId,
  pageName: z.string().max(4096),
  remainingPages: count.max(50),
  removedFiles: count.max(2000),
  removedDirectories: count.max(2000),
  removedBytes: count.max(256 * 1024 * 1024),
  memoryChanged: z.boolean(),
  memoryRowsBefore: count,
  memoryRowsAfter: count,
};
const receipt = mcpChapterDeletionOutputs.carrot_delete_chapter
  .extend({ pageId })
  .strict();
const catalog = mcpChapterDeletionOutputs.carrot_list_chapter_deletions;
export const mcpPageDeletionOutputs = {
  carrot_preview_page_deletion:
    mcpChapterDeletionOutputs.carrot_preview_chapter_deletion
      .extend(summary)
      .strict(),
  carrot_delete_page: receipt,
  carrot_get_page_deletion:
    mcpChapterDeletionOutputs.carrot_get_chapter_deletion
      .extend(summary)
      .strict(),
  carrot_list_page_deletions: catalog
    .extend({
      items: z
        .array(
          catalog.shape.items.element.extend({
            kind: z.literal("page-deletion"),
            pageCount: z.literal(1),
          }),
        )
        .max(25),
    })
    .strict(),
  carrot_undo_page_deletion: receipt,
  carrot_redo_page_deletion: receipt,
  carrot_discard_page_deletion:
    mcpChapterDeletionOutputs.carrot_discard_chapter_deletion
      .omit({ chapterChanges: true })
      .extend({ pageChanges: z.literal(0) })
      .strict(),
};
