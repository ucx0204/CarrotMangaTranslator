import { z } from "zod/v4";
import {
  McpImportCreateSchema,
  McpImportReceiptSchema,
  type McpImportCreate,
  type McpImportReceipt,
} from "./mcpLibraryImport";

const selection = z
  .object({
    itemId: z.uuid(),
    previewId: McpImportCreateSchema.shape.previewId,
    snapshot: McpImportCreateSchema.shape.snapshot,
    chapters: McpImportCreateSchema.shape.chapters,
  })
  .strict();
/** Only reviewed IDs are accepted. No URLs, paths, bytes or implicit page selection. */
export const McpImportBatchPublishSchema = z
  .object({
    requestId: McpImportCreateSchema.shape.requestId,
    id: z.uuid(),
    version: z.number().int().nonnegative(),
    allowNativePreparation: McpImportCreateSchema.shape.allowNativePreparation,
    target: McpImportCreateSchema.shape.target,
    duplicatePolicy: McpImportCreateSchema.shape.duplicatePolicy,
    items: z.array(selection).min(1).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    const chapters = value.items.flatMap((item) => item.chapters);
    const pages = chapters.flatMap((chapter) => chapter.pageIds);
    const groups = [
      value.items.map((item) => item.itemId),
      value.items.map((item) => item.previewId),
      chapters.map((chapter) => chapter.draftId),
      pages,
    ];
    if (
      chapters.length > 10 ||
      pages.length > 50 ||
      groups.some((ids) => new Set(ids).size !== ids.length)
    )
      context.addIssue({
        code: "custom",
        message:
          "Choose distinct batch items, previews, drafts and pages; at most ten chapters and fifty pages total.",
      });
  });
export type McpImportBatchPublish = z.infer<typeof McpImportBatchPublishSchema>;
export const McpImportPublicationSchema = z.union([
  McpImportCreateSchema,
  McpImportBatchPublishSchema,
]);
export type McpImportPublication = McpImportCreate | McpImportBatchPublish;
export type McpImportSelection =
  | Pick<McpImportCreate, "previewId" | "snapshot" | "chapters" | "target">
  | Pick<McpImportBatchPublish, "items" | "target">;

export function importPublicationSelections(input: McpImportSelection) {
  return "items" in input ? input.items : [input];
}
export function importPublicationChapters(input: McpImportPublication) {
  return importPublicationSelections(input).flatMap((item) => item.chapters);
}
export function importPublicationMapping(
  input: McpImportPublication,
  chapterIds: string[],
) {
  if (!("items" in input)) return undefined;
  let offset = 0;
  return {
    id: input.id,
    items: input.items.map((item) => {
      const ids = chapterIds.slice(offset, offset + item.chapters.length);
      offset += item.chapters.length;
      return {
        itemId: item.itemId,
        previewId: item.previewId,
        chapterIds: ids,
        pageCount: item.chapters.reduce(
          (sum, chapter) => sum + chapter.pageIds.length,
          0,
        ),
      };
    }),
  };
}
/** Shared journal/native receipt consistency; never manufactures a saved receipt. */
export function matchesImportPublication(
  input: McpImportPublication,
  receipt: McpImportReceipt,
) {
  const chapters = importPublicationChapters(input);
  return (
    McpImportReceiptSchema.safeParse(receipt).success &&
    input.requestId === receipt.requestId &&
    chapters.length === receipt.chapterIds.length &&
    new Set(receipt.chapterIds).size === receipt.chapterIds.length &&
    chapters.reduce((sum, chapter) => sum + chapter.pageIds.length, 0) ===
      receipt.pageCount &&
    (input.target.mode !== "existing" ||
      input.target.workId === receipt.workId) &&
    JSON.stringify(receipt.batch) ===
      JSON.stringify(importPublicationMapping(input, receipt.chapterIds)) &&
    (!("items" in input) || receipt.source === "web")
  );
}
