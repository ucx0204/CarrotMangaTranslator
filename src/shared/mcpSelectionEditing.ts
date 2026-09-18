import { z } from "zod/v4";
import { McpSourceRectPatchSchema } from "./mcpSourceRect";
import { McpTranslationBatchPreviewSchema, mcpTranslationBatchOutputs } from "./mcpTranslationBatch";

const { blockId } = McpSourceRectPatchSchema.shape;
const entryId = z.string().min(1).max(200);
export const McpBlockReferenceFieldsSchema = z.object({
  speakerId: entryId.nullable().optional(), glossaryEntryIds: z.array(entryId).max(50).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Choose at least one reference field.");
const edit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), blockId, itemId: blockId, reason: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("translation"), blockId, itemId: blockId, reason: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("append"), blockId, itemId: blockId, sequence: z.number().int().nonnegative().max(99), reason: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("references"), blockId, fields: McpBlockReferenceFieldsSchema, reason: z.string().min(1).max(500) }).strict(),
]);
export const McpSelectionEditPreviewSchema = McpTranslationBatchPreviewSchema.omit({ allowEmpty: true }).extend({
  analysisId: z.uuid().optional(), allowOverlaps: z.boolean().default(false),
  pages: z.array(McpTranslationBatchPreviewSchema.shape.pages.element.extend({ edits: z.array(edit).min(1).max(100) }).strict()).min(1).max(20),
}).strict();
export type McpSelectionEditPreview = z.infer<typeof McpSelectionEditPreviewSchema>;
const state = z.object({
  sourceText: z.string().max(20000), translatedText: z.string().max(20000),
  speakerId: entryId.optional(), glossaryEntryIds: z.array(entryId).max(50).optional(),
}).strict();
const change = z.object({
  pageId: z.string(), blockId, kind: z.enum(["source", "translation", "append", "references"]),
  reason: z.string(), before: state.nullable(), after: state, changed: z.boolean(),
  excludedReason: z.string().nullable(), warnings: z.array(z.string()),
}).strict();
export type McpSelectionChangeView = z.infer<typeof change>;
export const mcpSelectionEditingOutputs = {
  carrot_preview_selection_edits: mcpTranslationBatchOutputs.carrot_preview_translation_batch,
  carrot_get_selection_edits: mcpTranslationBatchOutputs.carrot_get_translation_batch.extend({ changes: z.array(change).max(25) }).strict(),
  carrot_apply_selection_edits: mcpTranslationBatchOutputs.carrot_apply_translation_batch,
  carrot_undo_selection_edits: mcpTranslationBatchOutputs.carrot_undo_translation_batch,
  carrot_redo_selection_edits: mcpTranslationBatchOutputs.carrot_redo_translation_batch,
  carrot_cancel_selection_edits: mcpTranslationBatchOutputs.carrot_cancel_translation_batch,
};
