import { z } from "zod/v4";
import type { TranslationBlock } from "./textTypes";
import {
  MIN_FONT_SIZE_PX,
  MAX_FONT_SIZE_PX,
  MIN_LINE_HEIGHT,
  MAX_LINE_HEIGHT,
  MIN_LETTER_SPACING_EM,
  MAX_LETTER_SPACING_EM,
  MIN_FONT_WIDTH_SCALE,
  MAX_FONT_WIDTH_SCALE,
} from "./blockFormatValues";

const text = z.string().max(20000);
const color = z.string().regex(/^#[a-f0-9]{6}$/i);
const finite = z.number().finite();
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const target = {
  chapterId: id,
  pageId: id,
  revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
};
/** Scalar fields supported by the existing conditional batch engine, not an internal block object. */
export const McpEditableFieldsSchema = z
  .object({
    sourceText: text,
    translatedText: text,
    fontFamily: z.string().min(1).max(120),
    fontSizePx: finite.min(MIN_FONT_SIZE_PX).max(MAX_FONT_SIZE_PX),
    autoFitText: z.boolean(),
    textAlign: z.enum(["left", "center", "right"]),
    renderDirection: z.enum(["horizontal", "vertical"]),
    lineHeight: finite.min(MIN_LINE_HEIGHT).max(MAX_LINE_HEIGHT),
    letterSpacing: finite.min(MIN_LETTER_SPACING_EM).max(MAX_LETTER_SPACING_EM),
    fontWidthScale: finite.min(MIN_FONT_WIDTH_SCALE).max(MAX_FONT_WIDTH_SCALE),
    wordBreak: z.enum([
      "normal",
      "break-word",
      "break-all",
      "keep-all",
      "keep-all-overflow",
    ]),
    textColor: color,
    textOpacity: finite.min(0).max(1),
    outlineColor: color,
    outlineWidthPx: finite.min(0).max(64),
    outerOutlineColor: color,
    outerOutlineWidthPx: finite.min(0).max(64),
    bold: z.boolean(),
    italic: z.boolean(),
    underline: z.boolean(),
    strikethrough: z.boolean(),
    emphasisMark: z.boolean(),
    textBackgroundEnabled: z.boolean(),
    textBackgroundColor: color,
    rotationDeg: finite.min(-180).max(180),
    inpaintExcluded: z.boolean(),
    reviewStatus: z.enum(["draft", "needs_review", "reviewed"]),
    reviewNote: z.string().max(4000),
    textRole: z.enum(["ordinary", "sound"]),
  })
  .partial()
  .strict();
export type McpEditableFields = z.infer<typeof McpEditableFieldsSchema>;
const renderRect = z
  .object({
    x: finite.int(),
    y: finite.int(),
    w: finite.int().positive(),
    h: finite.int().positive(),
  })
  .strict();
const edit = z
  .object({
    blockId: id,
    fields: McpEditableFieldsSchema.optional(),
    renderRect: renderRect.optional(),
  })
  .strict()
  .refine(
    (value) => !!value.renderRect || Object.keys(value.fields ?? {}).length > 0,
    "Specify at least one field or a render rectangle.",
  );
export const McpBlockPatchSchema = z
  .object({ ...target, edits: z.array(edit).min(1).max(100) })
  .strict();
export type McpBlockPatch = z.infer<typeof McpBlockPatchSchema>;
export const McpReadingOrderSchema = z
  .object({ ...target, blockIds: z.array(id).max(5000) })
  .strict();
export type McpReadingOrder = z.infer<typeof McpReadingOrderSchema>;

/** No image bytes, paths, masks or opaque generated artifacts leave through this projection. */
export function projectMcpEditableFields(
  block: TranslationBlock,
): McpEditableFields {
  const keys = Object.keys(
    McpEditableFieldsSchema.shape,
  ) as (keyof McpEditableFields)[];
  return Object.fromEntries(
    keys
      .filter((key) => block[key] !== undefined)
      .map((key) => [key, block[key]]),
  ) as McpEditableFields;
}
