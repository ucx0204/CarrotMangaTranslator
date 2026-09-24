import { z } from "zod/v4";
import { McpFormatBatchPreviewSchema } from "./mcpFormatBatch";
import { McpFormatFieldsSchema } from "./mcpFormatEditing";
import { mcpTranslationBatchOutputs } from "./mcpTranslationBatch";
import { FONT_MATCHING_SEMANTIC_ROLES } from "./fontMatchingProfileTypes";
import type { TranslationBlock } from "./textTypes";

const page = McpFormatBatchPreviewSchema.shape.pages.element;
const edit = z
  .object({
    blockId: page.shape.edits.element.shape.blockId,
    mode: z.enum(["font", "size", "font-and-size"]),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const McpTypographyBatchPreviewSchema =
  McpFormatBatchPreviewSchema.extend({
    analysisJobId: z.string().uuid(),
    pages: z
      .array(page.extend({ edits: z.array(edit).min(1).max(100) }))
      .min(1)
      .max(50),
  }).strict();
export type McpTypographyBatchPreview = z.infer<
  typeof McpTypographyBatchPreviewSchema
>;

/** Exactly the scalar state written by the canonical font and source-size appliers. */
const McpTypographyStateSchema = McpFormatFieldsSchema.pick({
  fontFamily: true,
  fontSizePx: true,
  autoFitText: true,
  bold: true,
  italic: true,
  outlineColor: true,
})
  .extend({
    fontWeight: z.number().finite().optional(),
    fontRole: z.enum(FONT_MATCHING_SEMANTIC_ROLES).optional(),
    fontRoleConfidence: z.number().min(0).max(1).optional(),
    fontSizeIntent: z.enum(["source-match", "manual"]).optional(),
    sourceFontFacePx: z.number().positive().optional(),
    sourceFontSizeConfidence: z.number().min(0).max(1).optional(),
    sourceFontSizeMethod: z.literal("raster-core-v1").optional(),
  })
  .strict();
const keys = new Set(Object.keys(McpTypographyStateSchema.shape));
export function projectMcpTypographyState(block: TranslationBlock) {
  return McpTypographyStateSchema.parse(
    Object.fromEntries(
      Object.entries(block).filter(
        ([key, value]) => keys.has(key) && value !== undefined,
      ),
    ),
  );
}
const change = z
  .object({
    pageId: page.shape.pageId,
    blockId: edit.shape.blockId,
    reason: edit.shape.reason,
    requested: edit,
    before: McpTypographyStateSchema,
    after: McpTypographyStateSchema,
    fontExclusion: z.string().nullable(),
    sizeExclusion: z.string().nullable(),
    excludedReason: z.string().nullable(),
    warnings: z.array(z.string()),
    changed: z.boolean(),
  })
  .strict();
export type McpTypographyChangeView = z.infer<typeof change>;
export const mcpTypographyBatchOutputs = {
  carrot_preview_typography_batch:
    mcpTranslationBatchOutputs.carrot_preview_translation_batch,
  carrot_get_typography_batch:
    mcpTranslationBatchOutputs.carrot_get_translation_batch.extend({
      changes: z.array(change).max(25),
    }),
  carrot_apply_typography_batch:
    mcpTranslationBatchOutputs.carrot_apply_translation_batch,
  carrot_undo_typography_batch:
    mcpTranslationBatchOutputs.carrot_undo_translation_batch,
  carrot_redo_typography_batch:
    mcpTranslationBatchOutputs.carrot_redo_translation_batch,
  carrot_cancel_typography_batch:
    mcpTranslationBatchOutputs.carrot_cancel_translation_batch,
};
