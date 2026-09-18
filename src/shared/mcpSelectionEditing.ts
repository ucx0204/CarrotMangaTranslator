import { z } from "zod/v4";
import { McpSourceRectPatchSchema } from "./mcpSourceRect";
import { mcpTranslationBatchOutputs } from "./mcpTranslationBatch";

const { chapterId, pageId, blockId, revision, sourceRect } =
  McpSourceRectPatchSchema.shape;
const reason = z.string().trim().min(1).max(500);
const referenceId = z.string().trim().min(1).max(200);
const observed = { itemId: blockId, reason };
const edit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), ...observed }).strict(),
  z.object({ kind: z.literal("translation"), ...observed }).strict(),
  z.object({
    kind: z.literal("append"), ...observed,
    sequence: z.number().int().min(0).max(99),
    allowOverlap: z.boolean().default(false),
    afterBlockId: blockId.nullable().optional(),
  }).strict(),
  z.object({
    kind: z.literal("references"), blockId, reason,
    speakerId: referenceId.nullable().optional(),
    glossaryEntryIds: z.array(referenceId).max(100).nullable().optional(),
  }).strict(),
]);
/** IDs select owned observations. Raw model results, blocks and arbitrary text are not inputs. */
export const McpSelectionBatchPreviewSchema = z.object({
  chapterId,
  contextRevision: z.string().regex(/^[a-f0-9]{16}$/),
  requestId: z.uuid(),
  reason: z.string().trim().min(1).max(2000),
  command: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("analysis"), analysisId: z.uuid() }).strict(),
    z.object({ kind: z.literal("references") }).strict(),
  ]),
  pages: z.array(z.object({
    pageId, revision, edits: z.array(edit).min(1).max(100),
  }).strict()).min(1).max(20),
}).strict();
export type McpSelectionBatchPreview = z.infer<typeof McpSelectionBatchPreviewSchema>;
export type McpSelectionEdit = z.infer<typeof edit>;
const state = z.object({
  sourceText: z.string().max(20000),
  translatedText: z.string().max(20000),
  speakerId: z.string().optional(),
  glossaryEntryIds: z.array(z.string()).optional(),
}).strict();
const change = z.object({
  pageId, blockId, reason, requested: edit,
  before: state.nullable(), after: state.nullable(),
  sourceRect: sourceRect.nullable(),
  overlapBlockIds: z.array(blockId).max(5000),
  excludedReason: z.string().nullable(),
  changed: z.boolean(), warnings: z.array(z.string()),
}).strict();
export type McpSelectionChangeView = z.infer<typeof change>;
export const mcpSelectionBatchOutputs = {
  carrot_preview_selection_batch: mcpTranslationBatchOutputs.carrot_preview_translation_batch,
  carrot_get_selection_batch: mcpTranslationBatchOutputs.carrot_get_translation_batch.extend({
    changes: z.array(change).max(25),
  }).strict(),
  carrot_apply_selection_batch: mcpTranslationBatchOutputs.carrot_apply_translation_batch,
  carrot_undo_selection_batch: mcpTranslationBatchOutputs.carrot_undo_translation_batch,
  carrot_redo_selection_batch: mcpTranslationBatchOutputs.carrot_redo_translation_batch,
  carrot_cancel_selection_batch: mcpTranslationBatchOutputs.carrot_cancel_translation_batch,
};
