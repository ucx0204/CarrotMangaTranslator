import { z } from "zod/v4";
import {
  MCP_EXCHANGE_BYTES,
  McpTextExchangeBindingSchema,
  McpTextExchangeOptionsSchema,
} from "./mcpExchangeFiles";
import { mcpTranslationBatchOutputs } from "./mcpTranslationBatch";
import { McpEditableFieldsSchema } from "./mcpBlockEditing";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const fingerprint = z.string().regex(/^[a-f0-9]{16}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
export const McpTextExportReviewInputSchema = z
  .object({
    chapterId: id,
    pageIds: z.array(id).min(1).max(50).optional(),
    options: McpTextExchangeOptionsSchema,
  })
  .strict();
export type McpTextExportReviewInput = z.infer<
  typeof McpTextExportReviewInputSchema
>;
export const McpTextExportTargetSchema = z
  .object({
    binding: McpTextExchangeBindingSchema,
    requestId: z.uuid(),
  })
  .strict();
export type McpTextExportTarget = z.infer<typeof McpTextExportTargetSchema>;
export const McpTextExportReviewOutputSchema = z
  .object({
    binding: McpTextExchangeBindingSchema,
    bytes: count.max(MCP_EXCHANGE_BYTES),
    pageCount: count.min(1).max(50),
    blockCount: count,
    rowCount: count,
    omissions: z.array(z.string().max(160)).max(20),
    warnings: z.array(z.string().max(240)).max(20),
    executionReserved: z.literal(false),
  })
  .strict();
export type McpTextExportReview = z.infer<
  typeof McpTextExportReviewOutputSchema
>;

export const McpTextImportPreviewSchema = z
  .object({
    source: McpTextExchangeBindingSchema,
    uploadId: z.uuid(),
    sha256,
    contextRevision: fingerprint,
    requestId: z.uuid(),
    reason: z.string().trim().min(1).max(2000),
    selection: z
      .array(
        z
          .object({
            pageId: id,
            blockIds: z.array(id).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    allowEmpty: z.boolean().default(false),
    updateSourceText: z.boolean().default(false),
    requireSourceMatch: z.boolean().default(true),
  })
  .strict()
  .refine(
    (input) =>
      input.source.options.format !== "txt" ||
      (input.source.options.field !== "source" && !input.updateSourceText),
    "TXT imports translation fields from both/translated exports only.",
  );
export type McpTextImportPreview = z.infer<typeof McpTextImportPreviewSchema>;
export const McpTextImportApplySchema = z
  .object({
    batchId: z.uuid(),
    requestId: z.uuid(),
    acknowledgePageByPage: z.literal(true),
  })
  .strict();
export type McpTextImportApply = z.infer<typeof McpTextImportApplySchema>;
const sourceInfo = z
  .object({
    uploadId: z.uuid(),
    sha256,
    sourceBytes: count.min(1).max(MCP_EXCHANGE_BYTES),
    utf8Bytes: count.max(MCP_EXCHANGE_BYTES),
    format: z.enum(["txt", "csv", "tsv"]),
    decoding: z.literal("native-utf8-then-windows-949"),
  })
  .strict();
export type McpTextImportSourceInfo = z.infer<typeof sourceInfo>;
const McpTextImportDiagnosticSchema = z
  .object({
    code: z.string().max(100),
    row: count.optional(),
    field: z.string().max(240).optional(),
    pageId: id.optional(),
    blockId: id.optional(),
    message: z.string().max(1000).optional(),
  })
  .strict();
export type McpTextImportDiagnostic = z.infer<
  typeof McpTextImportDiagnosticSchema
>;
export const McpTextImportFieldsSchema = McpEditableFieldsSchema.pick({
  sourceText: true,
  translatedText: true,
  reviewStatus: true,
  reviewNote: true,
}).required({ sourceText: true, translatedText: true });
const McpTextImportChangeSchema = z
  .object({
    pageId: id,
    blockId: id,
    before: McpTextImportFieldsSchema,
    after: McpTextImportFieldsSchema,
    changed: z.boolean(),
    excludedReason: z.string().nullable(),
    warnings: z.array(z.string().max(160)).max(5),
  })
  .strict();
export type McpTextImportChange = z.infer<typeof McpTextImportChangeSchema>;
const summary = mcpTranslationBatchOutputs.carrot_preview_translation_batch
  .extend({
    input: sourceInfo,
    diagnosticCount: count,
    application: z.literal("page-by-page"),
    notes: z.array(z.string().max(240)).max(20),
  })
  .strict();
export const mcpTextExchangeOutputs = {
  carrot_preflight_text_export: McpTextExportReviewOutputSchema,
  carrot_preview_text_file_import: summary,
  carrot_get_text_file_import: summary
    .extend({
      offset: count,
      limit: count,
      nextOffset: count.nullable(),
      changes: z.array(McpTextImportChangeSchema).max(25),
      diagnostics: z.array(McpTextImportDiagnosticSchema).max(25),
      nextDiagnosticOffset: count.nullable(),
    })
    .strict(),
};
