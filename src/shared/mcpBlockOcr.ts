import { z } from "zod/v4";
import { McpSourceRectPatchSchema } from "./mcpSourceRect";

/** A fresh, explicit local OCR observation, never a page edit. */
export const McpBlockOcrTargetSchema = McpSourceRectPatchSchema.omit({
  sourceRect: true,
}).extend({ requestId: z.string().uuid() });
export type McpBlockOcrTarget = z.infer<typeof McpBlockOcrTargetSchema>;

const rect = McpSourceRectPatchSchema.shape.sourceRect;
const region = z
  .object({
    sequence: z.number().int().nonnegative(),
    sourceText: z.string().max(20_000),
    sourceRect: rect,
    sourceDirection: z.enum(["horizontal", "vertical"]),
    textRole: z.enum(["ordinary", "sound"]),
  })
  .strict();

/** Public text evidence only. Original-image coordinates; engine region order.
 * This transient payload is deliberately omitted from the persistent journal. */
export const McpBlockOcrObservationSchema = z
  .object({
    sourceRect: rect,
    cropRect: rect,
    previousSourceText: z.string().max(20_000),
    recognizedText: z.string().max(20_000),
    differs: z.boolean(),
    sourceLanguage: z.string().max(32),
    sourceCropSha256: z.string().regex(/^[a-f0-9]{64}$/),
    readingOrder: z.literal("app-crop-heuristic"),
    regions: z.array(region).max(100),
    warnings: z.array(
      z.enum([
        "review_before_apply",
        "multiple_regions",
        "no_text_keep_existing",
        "source_evidence_retained",
      ]),
    ).max(4),
  })
  .strict()
  .refine(
    (value) => value.regions.reduce((n, item) => n + item.sourceText.length, 0) <= 20_000,
    "OCR text exceeds the observation limit; no truncation is allowed.",
  );
export type McpBlockOcrObservation = z.infer<typeof McpBlockOcrObservationSchema>;
