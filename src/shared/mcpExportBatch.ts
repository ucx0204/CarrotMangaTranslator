import { z } from "zod/v4";
import { mcpReviewOutputSchemas } from "./mcpReviewSchemas";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const count = z.number().int().nonnegative();
const revision = z.string().regex(/^page-v1:[a-f0-9]{16}$/);
const snapshot = z.string().regex(/^[a-f0-9]{16}$/);
const pageTarget = z.object({ pageId: id, revision }).strict();
export const McpExportPreflightInput = z
  .object({
    chapterId: id,
    pageIds: z.array(id).min(1).max(50).optional(),
  })
  .strict();
export const McpExportPagesTargetSchema = z
  .object({
    chapterId: id,
    snapshot,
    pages: z.array(pageTarget).min(1).max(50),
    requestId: z.string().uuid(),
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
  filename: z.string().regex(/^[0-9]+\.png$/),
  width: z.number().positive(),
  height: z.number().positive(),
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
    executionReserved: z.literal(false),
    notChecked: z.array(z.string()),
  })
  .strict();
const exportPage = z.object({
  ...pageMetadata,
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
});
export type McpExportPagesTarget = z.infer<typeof McpExportPagesTargetSchema>;
export type McpExportZipTarget = z.infer<typeof McpExportZipTargetSchema>;
export type McpExportPagesMetadata = z.infer<
  typeof McpExportPagesMetadataSchema
>;
export type McpExportPageResult = McpExportPagesMetadata["pages"][number] & {
  url?: string;
};
