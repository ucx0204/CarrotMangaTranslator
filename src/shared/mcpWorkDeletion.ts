import { z } from "zod/v4";
import {
  McpChapterDeletionTargetSchema,
  McpChapterDeletionApplySchema,
  mcpChapterDeletionOutputs,
} from "./mcpChapterDeletion";

export const McpWorkDeletionTargetSchema = McpChapterDeletionTargetSchema.pick({
  workId: true,
});
export const McpWorkDeletionApplySchema = McpChapterDeletionApplySchema.omit({
  chapterId: true,
})
  .extend({
    confirm: z.literal("delete-work-with-seven-day-recovery"),
  })
  .strict();
export type McpWorkDeletionApply = z.infer<typeof McpWorkDeletionApplySchema>;
const chapter = z
  .object({
    chapterId: McpChapterDeletionTargetSchema.shape.chapterId,
    title: z.string().max(4096),
    pageCount: z.number().int().nonnegative().max(50),
  })
  .strict();
const chapters = z.array(chapter).max(10);
const receipt = mcpChapterDeletionOutputs.carrot_delete_chapter.omit({
  chapterId: true,
});
const list = mcpChapterDeletionOutputs.carrot_list_chapter_deletions;

/** Work removal is separate from chapter removal; acknowledgement covers the whole reviewed directory. */
export const mcpWorkDeletionOutputs = {
  carrot_preview_work_deletion:
    mcpChapterDeletionOutputs.carrot_preview_chapter_deletion
      .omit({ chapterId: true, chapterTitle: true })
      .extend({ chapters })
      .strict(),
  carrot_delete_work: receipt,
  carrot_undo_work_deletion: receipt,
  carrot_redo_work_deletion: receipt,
  carrot_get_work_deletion:
    mcpChapterDeletionOutputs.carrot_get_chapter_deletion
      .omit({ chapterId: true, chapterTitle: true })
      .extend({ chapters })
      .strict(),
  carrot_list_work_deletions: list.extend({
    items: z
      .array(
        list.shape.items.element.extend({ kind: z.literal("work-deletion") }),
      )
      .max(25),
  }),
  carrot_discard_work_deletion:
    mcpChapterDeletionOutputs.carrot_discard_chapter_deletion
      .omit({ chapterChanges: true })
      .extend({ workChanges: z.literal(0) })
      .strict(),
};
