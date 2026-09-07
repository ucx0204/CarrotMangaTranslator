import {
  letteringMaskStrokesSchema,
  letteringOcclusionSchema,
} from "./generatedLetteringMaskSchemas";
import { z } from "zod";
import {
  MAX_FONT_SIZE_PX,
  MAX_FONT_WIDTH_SCALE,
  MAX_LETTER_SPACING_EM,
  MAX_LINE_HEIGHT,
  MIN_FONT_SIZE_PX,
  MIN_FONT_WIDTH_SCALE,
  MIN_LETTER_SPACING_EM,
  MIN_LINE_HEIGHT,
} from "./blockFormatValues";

const finiteNumber = z.number().finite();

export const FontSizePxSchema = finiteNumber
  .min(MIN_FONT_SIZE_PX)
  .max(MAX_FONT_SIZE_PX);
export const LineHeightSchema = finiteNumber
  .min(MIN_LINE_HEIGHT)
  .max(MAX_LINE_HEIGHT);
export const LetterSpacingSchema = finiteNumber
  .min(MIN_LETTER_SPACING_EM)
  .max(MAX_LETTER_SPACING_EM);
export const FontWidthScaleSchema = finiteNumber
  .min(MIN_FONT_WIDTH_SCALE)
  .max(MAX_FONT_WIDTH_SCALE);

export const generatedLettering = z
  .object({
    maskStrokes: letteringMaskStrokesSchema.optional(),
    occlusionPolygons: letteringOcclusionSchema.optional(),
    version: z.literal(1),
    enabled: z.boolean().optional(),
    dataUrl: z
      .string()
      .max(8_000_000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/),
    translatedText: z.string().max(20000),
    sourceText: z.string().max(20000),
  })
  .strict();
