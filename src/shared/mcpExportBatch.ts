import { z } from "zod/v4";
import { mcpReviewOutputSchemas } from "./mcpReviewSchemas";
import {
  McpPageExportOptionsSchema,
  McpRasterExportOptionsSchema,
  McpArtifactMimeSchema,
} from "./mcpOutputFormats";

/** Source is a reviewed batch policy; renderer and single-file options stay concrete. */
const sourceExportOptions = z
  .object({
    format: z.literal("source"),
    omitText: z.boolean().default(false),
    jpegQuality: z.number().int().min(1).max(100),
    webpQuality: z.number().int().min(1).max(100),
    unsupportedSource: z.enum(["png", "reject"]),
  })
  .strict();
export const McpBatchRasterExportOptionsSchema = z.union([
  McpRasterExportOptionsSchema,
  sourceExportOptions,
]);
const batchExportOptions = z.union([
  McpPageExportOptionsSchema,
  sourceExportOptions,
]);
export type McpBatchExportOptions = z.infer<typeof batchExportOptions>;
export type McpExportSourceName = {
  sourceNameFingerprint: string;
  format: "png" | "jpeg" | "webp";
  fallback: "none" | "unsupported-source-to-png";
};

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const count = z.number().int().nonnegative();
const revision = z.string().regex(/^page-v1:[a-f0-9]{16}$/);
const snapshot = z.string().regex(/^[a-f0-9]{16}$/);
const pageTarget = z.object({ pageId: id, revision }).strict();
export const McpExportPreflightInput = z
  .object({
    chapterId: id,
    pageIds: z.array(id).min(1).max(50).optional(),
    imageExport: batchExportOptions.optional(),
  })
  .strict();
export const McpExportPagesTargetSchema = z
  .object({
    chapterId: id,
    snapshot,
    pages: z.array(pageTarget).min(1).max(50),
    requestId: z.string().uuid(),
    imageExport: batchExportOptions.optional(),
  })
  .strict();
export const McpExportZipTargetSchema = z
  .object({
    sourceJobId: z.string().uuid(),
    allowPartial: z.boolean().default(false),
    requestId: z.string().uuid(),
  })
  .strict();
const pageMetadata = {
  pageId: id,
  revision,
  pageIndex: count,
  filename: z.string().regex(/^[0-9]+\.(png|jpg|webp|psd)$/),
  width: z.number().positive(),
  height: z.number().positive(),
  imageExport: McpRasterExportOptionsSchema.optional(),
  sourceFormatBasis: z.literal("saved-source-name").optional(),
  fallback: z.enum(["none", "unsupported-source-to-png"]).optional(),
};
export const McpExportPreflightOutput = z
  .object({
    chapterId: id,
    snapshot,
    pages: z
      .array(
        z
          .object({
            ...pageMetadata,
            issues:
              mcpReviewOutputSchemas.carrot_preflight_page_export.shape.issues,
          })
          .strict(),
      )
      .max(50),
    imageExport: batchExportOptions.optional(),
    executionReserved: z.literal(false),
    notChecked: z.array(z.string()),
  })
  .strict();
const exportPage = z.object({
  ...pageMetadata,
  mimeType: McpArtifactMimeSchema.optional(),
  retainedOutputId: z.string().uuid().optional(),
  status: z.enum(["exported", "failed", "cancelled", "unprocessed"]),
  code: z.string().max(128).optional(),
  bytes: count.optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  expiresAt: count.optional(),
});
// Nested projection deliberately strips private capability URLs and file paths.
export const McpExportPagesMetadataSchema = z.object({
  chapterId: id,
  snapshot,
  total: count,
  completed: count,
  pages: z.array(exportPage).max(50),
  imageExport: batchExportOptions.optional(),
});
export type McpExportPagesTarget = z.infer<typeof McpExportPagesTargetSchema>;
export type McpExportZipTarget = z.infer<typeof McpExportZipTargetSchema>;
type McpExportPagesMetadata = z.infer<typeof McpExportPagesMetadataSchema>;
export type McpExportPageResult = McpExportPagesMetadata["pages"][number] & {
  url?: string;
};
