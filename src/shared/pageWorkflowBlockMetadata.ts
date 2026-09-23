import { z } from "zod";

const PixelBox = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
export const WorkflowRecognitionSegmentSchema = z.object({
  x1: z.number().finite(),
  y1: z.number().finite(),
  x2: z.number().finite(),
  y2: z.number().finite(),
  ocrText: z.string().max(20000),
});
export const WorkflowBlockMetadataSchema = z
  .object({
    geometryKey: z.string().max(100),
    recognitionBboxes: z.array(PixelBox).max(100).optional(),
    recognitionSegments: z
      .array(WorkflowRecognitionSegmentSchema)
      .max(100)
      .optional(),
    initialFontSize: z.number().finite(),
    initialFontFamily: z.string().optional(),
    initialFontStyle: z
      .object({
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        fontWeight: z.number().optional(),
        textColor: z.string(),
        outlineColor: z.string().optional(),
      })
      .strict()
      .optional(),
    fontApplied: z.boolean().optional(),
    sizeApplied: z.boolean().optional(),
  })
  .strict();

export type WorkflowBlockMetadata = z.infer<typeof WorkflowBlockMetadataSchema>;
