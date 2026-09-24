import { z } from "zod/v4";
import {
  McpImportPageMappingSchema,
  matchesMcpImportPageMapping,
} from "./mcpImportMapping";
import { McpImportTargetSchema } from "./mcpLibraryImport";
import {
  McpChapterMovePreviewSchema,
  mcpChapterMoveOutputs,
} from "./mcpChapterMove";

const snapshot = z.string().regex(/^[a-f0-9]{16}$/);
const title = z.string().trim().min(1).max(240);
const packageId = z.string().min(1).max(200);
const count = z.number().int().nonnegative();
const id = McpImportTargetSchema.shape.workId;
const chapters = z
  .array(z.object({ packageChapterId: packageId, title }).strict())
  .min(1)
  .max(10)
  .refine(
    (items) =>
      new Set(items.map((item) => item.packageChapterId)).size === items.length,
    "Select each package chapter only once.",
  );
const appendFields = z
  .object({
    workId: id,
    contextPolicy: z.literal("preserve-destination"),
    references: McpChapterMovePreviewSchema.shape.intent.shape.references,
  })
  .strict();
function distinctMappings(value: z.infer<typeof appendFields>) {
  const keys = (value.references ?? []).map(
    (item) => `${item.kind}/${item.sourceId}`,
  );
  return new Set(keys).size === keys.length;
}
const mappingMessage = "Reference mappings must have distinct source keys.";
const appendIntent = appendFields.refine(distinctMappings, mappingMessage);
const appendTarget = appendFields
  .extend({ mode: z.literal("append"), snapshot })
  .refine(distinctMappings, mappingMessage);
export const McpWorkFileReviewSchema = z
  .object({ uploadId: z.uuid() })
  .strict();
export const McpWorkFileAppendReviewSchema = McpWorkFileReviewSchema.extend({
  snapshot,
  chapters,
  target: appendIntent,
}).strict();
export type McpWorkFileAppendReview = z.infer<
  typeof McpWorkFileAppendReviewSchema
>;
export const McpWorkFileCreateSchema = McpWorkFileReviewSchema.extend({
  requestId: z.uuid(),
  snapshot,
  target: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("new"), title }).strict(),
    appendTarget,
  ]),
  chapters,
  allowNativePreparation: z.literal(true),
  acknowledgeV1Limitations: z.literal(true),
}).strict();
export type McpWorkFileCreate = z.infer<typeof McpWorkFileCreateSchema>;
export const McpWorkFileReceiptGetSchema = z
  .object({ requestId: z.uuid() })
  .strict();
export const McpWorkFileReviewOutputSchema = z
  .object({
    uploadId: z.uuid(),
    snapshot,
    expiresAt: z.number().int().positive(),
    sourceBytes: count.max(128 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    workTitle: z.string().max(240),
    chapterCount: count.min(1).max(10),
    pageCount: count.min(1).max(50),
    chapters: z
      .array(
        z
          .object({
            packageChapterId: packageId,
            title: z.string().max(240),
            pageCount: count.max(50),
            blockCount: count,
            processedPageCount: count.max(50),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    hasStyleGuide: z.boolean(),
    uncompressedBytes: count.max(256 * 1024 * 1024),
    entryCount: count.max(2000),
    format: z.literal("mgtshare-v1"),
    targetMode: z.literal("new-work-only"),
    retention: z.literal("requires-live-upload"),
    warnings: z.array(z.string().max(240)).max(12),
  })
  .strict();
export type McpWorkFileReview = z.infer<typeof McpWorkFileReviewOutputSchema>;
export const McpWorkFileReceiptSchema = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    uploadId: z.uuid(),
    snapshot,
    status: z.literal("imported"),
    workId: id,
    chapterIds: z.array(z.uuid()).min(1).max(10),
    packageChapterIds: z.array(packageId).min(1).max(10),
    pageCount: count.min(1).max(50),
    createdAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    retention: z.literal("seven-days"),
    format: z.literal("mgtshare-v1"),
    pageMapping: McpImportPageMappingSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.chapterIds.length === value.packageChapterIds.length &&
      matchesMcpImportPageMapping(value) &&
      new Set(value.chapterIds).size === value.chapterIds.length &&
      new Set(value.packageChapterIds).size === value.packageChapterIds.length,
    "Inconsistent work-file chapter mapping.",
  );
export type McpWorkFileReceipt = z.infer<typeof McpWorkFileReceiptSchema>;
export function matchesWorkFileReceipt(
  input: McpWorkFileCreate,
  receipt: McpWorkFileReceipt,
): boolean {
  return (
    input.requestId === receipt.requestId &&
    input.uploadId === receipt.uploadId &&
    input.snapshot === receipt.snapshot &&
    (input.target.mode !== "append" ||
      input.target.workId === receipt.workId) &&
    input.chapters.length === receipt.packageChapterIds.length &&
    input.chapters.every(
      (chapter, index) =>
        chapter.packageChapterId === receipt.packageChapterIds[index],
    )
  );
}
export const mcpWorkFileOutputs = {
  carrot_preview_work_file: McpWorkFileReviewOutputSchema,
  carrot_get_work_file_import: McpWorkFileReceiptSchema,
  carrot_preview_work_file_append: z
    .object({
      uploadId: z.uuid(),
      snapshot,
      target: appendTarget,
      workTitle: z.string().max(4096),
      preservedChapterCount: count.max(2000),
      chapters: z
        .array(
          z
            .object({
              packageChapterId: packageId,
              title: z.string().max(4096),
              pageCount: count.max(50),
            })
            .strict(),
        )
        .min(1)
        .max(10),
      referenceIssues:
        mcpChapterMoveOutputs.carrot_preview_chapter_move.shape.referenceIssues,
      mappedReferences: count,
      eligible: z.boolean(),
      warnings: z.array(z.string().max(240)).max(12),
    })
    .strict(),
};
