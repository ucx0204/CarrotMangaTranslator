import { z } from "zod/v4";
import { InpaintingRetouchRequestSchema } from "./ipcJobSchemas";
import { McpSourceRectPatchSchema } from "./mcpSourceRect";
import { mcpTranslationBatchOutputs } from "./mcpTranslationBatch";

const { chapterId, pageId, blockId, revision } = McpSourceRectPatchSchema.shape;
const point = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();
const stroke = z
  .object({
    radiusPx: z.number().int().min(2).max(180),
    points: z.array(point).min(1).max(1200),
  })
  .strict();
// Native IPC uses Zod 3; the public JSON Schema uses Zod 4. Validate both contracts.
const geometry = z
  .discriminatedUnion("kind", [
    stroke.extend({ kind: z.literal("stroke") }),
    z
      .object({ kind: z.literal("rectangle"), start: point, end: point })
      .strict(),
    z.object({ kind: z.literal("ellipse"), start: point, end: point }).strict(),
  ])
  .refine(
    (value) =>
      InpaintingRetouchRequestSchema.shape.geometry.safeParse(value).success,
  );
const protectedAreas = z.array(geometry).max(50).default([]);
const engine = z.enum(["flux-klein", "lama-manga", "aot-inpainting"]);
const erasure = {
  expectedEngine: engine,
  allowAssetDownloads: z.boolean().default(false),
  protectedAreas,
};
const command = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("erase-blocks"),
      ...erasure,
      blockIds: z.array(blockId).min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("erase-mask"),
      ...erasure,
      strokes: z.array(stroke).min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("paint"),
      geometry,
      protectedAreas,
      color: z.string().regex(/^#[a-f0-9]{6}$/i),
    })
    .strict(),
  z.object({ kind: z.literal("restore"), geometry, protectedAreas }).strict(),
]);
export const McpImageEditPreviewSchema = z
  .object({
    chapterId,
    pageId,
    revision,
    contextRevision: z.string().regex(/^[a-f0-9]{16}$/),
    requestId: z.uuid(),
    reason: z.string().trim().min(1).max(2000),
    command,
  })
  .strict();
export type McpImageEditPreview = z.infer<typeof McpImageEditPreviewSchema>;
export type McpImageEditCommand = McpImageEditPreview["command"];
export const McpImageEditMaskGetSchema = z
  .object({ batchId: z.uuid() })
  .strict();
export const McpImageColorSampleSchema = z
  .object({
    chapterId,
    pageId,
    revision,
    image: z.enum(["original", "cleaned"]),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  })
  .strict();
export const MAX_MCP_IMAGE_EDIT_PIXELS = 16_000_000;
const count = z.number().int().nonnegative();
const mask = z
  .object({
    width: count.positive(),
    height: count.positive(),
    selectedPixels: count,
    protectedPixels: count,
    droppedPixels: count,
    components: count,
    snapshot: z.string().regex(/^[a-f0-9]{16}$/),
  })
  .strict();
const change = z
  .object({
    pageId,
    command,
    mask,
    changed: z.boolean(),
    excludedReason: z.string().nullable(),
    warnings: z.array(z.string()),
    outcome: z
      .object({
        changedPixels: count,
        componentsChanged: count,
        componentsIncomplete: count,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type McpImageEditChangeView = z.infer<typeof change>;
export const mcpImageEditOutputs = {
  carrot_preview_image_edit:
    mcpTranslationBatchOutputs.carrot_preview_translation_batch,
  carrot_get_image_edit:
    mcpTranslationBatchOutputs.carrot_get_translation_batch.extend({
      changes: z.array(change).max(1),
    }),
  carrot_apply_image_edit:
    mcpTranslationBatchOutputs.carrot_apply_translation_batch,
  carrot_undo_image_edit:
    mcpTranslationBatchOutputs.carrot_undo_translation_batch,
  carrot_redo_image_edit:
    mcpTranslationBatchOutputs.carrot_redo_translation_batch,
  carrot_cancel_image_edit:
    mcpTranslationBatchOutputs.carrot_cancel_translation_batch,
  carrot_get_image_edit_mask: mask
    .extend({
      batchId: z.uuid(),
      chapterId,
      pageId,
      revision,
      previewWidth: count.positive(),
      previewHeight: count.positive(),
      legend: z.literal("white=editable; blue=protected; black=unchanged"),
    })
    .strict(),
  carrot_sample_page_color: z
    .object({
      chapterId,
      pageId,
      revision,
      image: McpImageColorSampleSchema.shape.image,
      x: count,
      y: count,
      color: z.string().regex(/^#[a-f0-9]{6}$/),
    })
    .strict(),
};
