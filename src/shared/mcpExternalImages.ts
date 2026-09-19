import { z } from "zod/v4";
import { McpSourceRectPatchSchema } from "./mcpSourceRect";
import { mcpTranslationBatchOutputs } from "./mcpTranslationBatch";

const { chapterId, pageId, revision, blockId } = McpSourceRectPatchSchema.shape;
const coordinate = z.number().int().nonnegative().max(16_000_000);
const rect = z.object({ x: coordinate, y: coordinate,
  w: z.number().int().positive().max(16_000_000), h: z.number().int().positive().max(16_000_000),
}).strict();
const images = {
  imageUploadId: z.uuid(), maskUploadId: z.uuid().optional(),
  protectedMaskUploadId: z.uuid().optional(),
};
const command = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("replace-background"), ...images }).strict(),
  z.object({ kind: z.literal("patch-background"), ...images, rect }).strict(),
  z.object({ kind: z.literal("lettering"), ...images, blockId,
    replaceExisting: z.boolean().default(false),
    existingDecorations: z.enum(["preserve", "clear"]).default("preserve"),
  }).strict(),
]);
export const McpExternalImagePreviewSchema = z.object({
  chapterId, pageId, revision, contextRevision: z.string().regex(/^[a-f0-9]{16}$/),
  requestId: z.uuid(), reason: z.string().trim().min(1).max(2000), command,
}).strict();
export type McpExternalImagePreview = z.infer<typeof McpExternalImagePreviewSchema>;
export const McpExternalImageGetPreviewSchema = z.object({ batchId: z.uuid() }).strict();
const stats = z.object({
  width: z.number().int().positive(), height: z.number().int().positive(),
  selectedPixels: z.number().int().nonnegative(),
  protectedPixels: z.number().int().nonnegative(),
  changedPixels: z.number().int().nonnegative(),
  snapshot: z.string().regex(/^[a-f0-9]{16}$/),
}).strict();
const change = z.object({
  pageId, command, stats,
  changed: z.boolean(), excludedReason: z.string().nullable(),
  warnings: z.array(z.string()),
}).strict();
export type McpExternalImageChangeView = z.infer<typeof change>;
export const mcpExternalImageOutputs = {
  carrot_preview_external_image: mcpTranslationBatchOutputs.carrot_preview_translation_batch,
  carrot_get_external_image: mcpTranslationBatchOutputs.carrot_get_translation_batch.extend({ changes: z.array(change).max(1) }),
  carrot_apply_external_image: mcpTranslationBatchOutputs.carrot_apply_translation_batch,
  carrot_undo_external_image: mcpTranslationBatchOutputs.carrot_undo_translation_batch,
  carrot_redo_external_image: mcpTranslationBatchOutputs.carrot_redo_translation_batch,
  carrot_cancel_external_image: mcpTranslationBatchOutputs.carrot_cancel_translation_batch,
  carrot_get_external_image_preview: z.object({
    batchId: z.uuid(), chapterId, pageId, revision,
    kind: z.enum(["background-candidate", "lettering-asset"]),
    width: z.number().int().positive(), height: z.number().int().positive(),
    previewWidth: z.number().int().positive(), previewHeight: z.number().int().positive(),
    snapshot: z.string().regex(/^[a-f0-9]{16}$/),
  }).strict(),
};
