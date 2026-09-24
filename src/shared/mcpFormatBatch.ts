import { z } from "zod/v4";
import {
  McpTranslationBatchPreviewSchema,
  mcpTranslationBatchOutputs,
} from "./mcpTranslationBatch";
import { McpFormatEditSchema, McpFormatViewSchema } from "./mcpFormatEditing";

const target = McpTranslationBatchPreviewSchema.shape.pages.element;
export const McpFormatBatchPreviewSchema =
  McpTranslationBatchPreviewSchema.omit({ allowEmpty: true, pages: true })
    .extend({
      preserveManualFontSize: z.boolean().default(true),
      pages: z
        .array(
          target.extend({
            edits: z.array(McpFormatEditSchema).min(1).max(100),
          }),
        )
        .min(1)
        .max(50),
    })
    .strict();
export type McpFormatBatchPreview = z.infer<typeof McpFormatBatchPreviewSchema>;
const inspectedChange = z
  .object({
    pageId: target.shape.pageId,
    blockId: McpFormatEditSchema.shape.blockId,
    sourceText: z.string().max(20000),
    translatedText: z.string().max(20000),
    reason: z.string().max(500),
    requested: McpFormatEditSchema,
    before: McpFormatViewSchema,
    after: McpFormatViewSchema,
    warnings: z.array(z.string()),
    excludedReason: z.string().nullable(),
    changed: z.boolean(),
  })
  .strict();
export type McpFormatChangeView = z.infer<typeof inspectedChange>;
export const mcpFormatBatchOutputs = {
  carrot_preview_format_batch:
    mcpTranslationBatchOutputs.carrot_preview_translation_batch,
  carrot_get_format_batch:
    mcpTranslationBatchOutputs.carrot_get_translation_batch.extend({
      changes: z.array(inspectedChange).max(25),
    }),
  carrot_apply_format_batch:
    mcpTranslationBatchOutputs.carrot_apply_translation_batch,
  carrot_undo_format_batch:
    mcpTranslationBatchOutputs.carrot_undo_translation_batch,
  carrot_redo_format_batch:
    mcpTranslationBatchOutputs.carrot_redo_translation_batch,
  carrot_cancel_format_batch:
    mcpTranslationBatchOutputs.carrot_cancel_translation_batch,
};
