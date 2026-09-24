import { z } from "zod/v4";
import { McpImportCreateSchema } from "./mcpLibraryImport";

export const McpImportDuplicatesSchema = z
  .object({
    previewId: McpImportCreateSchema.shape.previewId,
    snapshot: McpImportCreateSchema.shape.snapshot,
    target: McpImportCreateSchema.shape.target,
    chapters: McpImportCreateSchema.shape.chapters,
  })
  .strict()
  .refine((value) => {
    const drafts = value.chapters.map((chapter) => chapter.draftId);
    const pages = value.chapters.flatMap((chapter) => chapter.pageIds);
    return (
      pages.length <= 50 &&
      new Set(pages).size === pages.length &&
      new Set(drafts).size === drafts.length
    );
  }, "Select distinct drafts and at most fifty distinct reviewed pages.");
export type McpImportDuplicates = z.infer<typeof McpImportDuplicatesSchema>;
const match = z.enum(["content-and-url", "content", "url"]);
export const mcpImportDuplicateOutputs = {
  carrot_get_import_duplicates: z
    .object({
      targetWorkId: z.string().nullable(),
      historyChapterCount: z.number().int().nonnegative(),
      untrackedChapterCount: z.number().int().nonnegative(),
      historicalOnly: z.literal(true),
      chapters: z
        .array(
          z
            .object({
              draftId: z.uuid(),
              status: z.enum(["known-content", "known-url", "unseen"]),
              matchingChapterCount: z.number().int().nonnegative(),
              matches: z
                .array(z.object({ chapterId: z.string(), match }).strict())
                .max(25),
              matchingDraftIds: z.array(z.uuid()).max(9),
            })
            .strict(),
        )
        .min(1)
        .max(10),
      warnings: z.array(z.string().max(1000)).max(5),
    })
    .strict(),
};
