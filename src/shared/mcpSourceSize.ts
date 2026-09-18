import { z } from "zod/v4";
import { McpSourceRectPatchSchema } from "./mcpSourceRect";

/** Raster evidence only; visible source face size is not a replacement fontSizePx. */
export const McpSourceSizeTargetSchema = McpSourceRectPatchSchema.omit({
  blockId: true,
  sourceRect: true,
}).extend({ requestId: z.string().uuid() });
export type McpSourceSizeTarget = z.infer<typeof McpSourceSizeTargetSchema>;
export const McpSourceSizeEstimateSchema = z
  .object({
    facePx: z.number().finite().positive().max(100000),
    confidence: z.number().min(0).max(1),
    method: z.literal("raster-core-v1"),
  })
  .strict();
export const McpSourceSizeObservationSchema = z
  .object({
    sourceImageSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().nonnegative(),
    measuredBlocks: z.number().int().min(0).max(1000),
    items: z
      .array(
        z
          .object({
            blockId: McpSourceRectPatchSchema.shape.blockId,
            estimate: McpSourceSizeEstimateSchema.nullable(),
            excludedReason: z
              .enum([
                "generated_lettering",
                "empty_source",
                "sound_effect_out_of_scope",
                "manual_font_size_preserved",
                "insufficient_raster_evidence",
              ])
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    notes: z.array(z.string().max(200)).max(10),
  })
  .strict();
export type McpSourceSizeObservation = z.infer<
  typeof McpSourceSizeObservationSchema
>;
