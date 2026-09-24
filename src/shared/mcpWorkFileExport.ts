import { z } from "zod/v4";

export const MCP_WORK_FILE_OUTPUT_BYTES = 128 * 1024 * 1024;
export const MCP_WORK_FILE_EXPANDED_BYTES = 256 * 1024 * 1024;
export const MCP_WORK_FILE_ENTRY_COUNT = 2000;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const snapshot = z.string().regex(/^[a-f0-9]{16}$/);
const revision = z.string().regex(/^page-v1:[a-f0-9]{16}$/);
const chapterIds = z
  .array(id)
  .min(1)
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate chapters.");

export const McpWorkFileExportReviewInputSchema = z
  .object({ workId: id, chapterIds })
  .strict();
export type McpWorkFileExportReviewInput = z.infer<
  typeof McpWorkFileExportReviewInputSchema
>;
export const McpWorkFileExportBindingSchema =
  McpWorkFileExportReviewInputSchema.extend({ snapshot }).strict();
export type McpWorkFileExportBinding = z.infer<
  typeof McpWorkFileExportBindingSchema
>;
export const McpWorkFileExportTargetSchema =
  McpWorkFileExportBindingSchema.extend({
    sourceSnapshot: snapshot,
    requestId: z.uuid(),
    acknowledgeOriginalImages: z.literal(true),
    acknowledgeV1Limitations: z.literal(true),
  }).strict();
export type McpWorkFileExportTarget = z.infer<
  typeof McpWorkFileExportTargetSchema
>;
export const McpWorkFileExportMetadataSchema =
  McpWorkFileExportBindingSchema.extend({
    sourceSnapshot: snapshot,
    format: z.literal("mgtshare-v1"),
    chapterCount: count.min(1).max(10),
    pageCount: count.min(1).max(50),
    blockCount: count,
  }).strict();
export const McpWorkFileExportReviewSchema =
  McpWorkFileExportMetadataSchema.extend({
    workTitle: z.string().max(240),
    chapters: z
      .array(
        z
          .object({
            chapterId: id,
            title: z.string().max(240),
            pageCount: count.max(50),
            blockCount: count,
            processedPageCount: count.max(50),
            pages: z.array(z.object({ pageId: id, revision }).strict()).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    sourceImageBytes: count.max(MCP_WORK_FILE_EXPANDED_BYTES),
    includesStyleGuide: z.literal(true),
    entryCount: count.max(MCP_WORK_FILE_ENTRY_COUNT),
    outputLimitBytes: z.literal(MCP_WORK_FILE_OUTPUT_BYTES),
    expandedLimitBytes: z.literal(MCP_WORK_FILE_EXPANDED_BYTES),
    sizingChecked: z.literal("during-native-write"),
    executionReserved: z.literal(false),
    warnings: z.array(z.string().max(240)).max(12),
  }).strict();
export type McpWorkFileExportReview = z.infer<
  typeof McpWorkFileExportReviewSchema
>;

/** Canonical explicit-file projection strips internal fields before disclosure. */
export const McpWorkFileExportArtifactSchema = z.object({
  kind: z.literal("native-work-file"),
  mimeType: z.literal("application/vnd.carrot.mgtshare"),
  filename: z.literal("carrot-work.mgtshare"),
  url: z.string().url(),
  bytes: count.min(1).max(MCP_WORK_FILE_OUTPUT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: count,
  access: z.string(),
  retainedOutputId: z.uuid().optional(),
  workFileExport: McpWorkFileExportMetadataSchema,
  performed: z.tuple([z.literal("package"), z.literal("export")]).optional(),
});
