import { z } from "zod/v4";
import { TranslationBlockObjectSchema } from "./ipcSchemaPrimitives";
import {
  MIN_BLOCK_LOCAL_COORDINATE,
  MAX_BLOCK_LOCAL_COORDINATE,
  MIN_CURVE_OFFSET_EM,
  MAX_CURVE_OFFSET_EM,
} from "./blockTransformPresets";
import {
  MIN_TEXT_EFFECT_OFFSET_PX,
  MAX_TEXT_EFFECT_OFFSET_PX,
  MAX_TEXT_EFFECT_BLUR_PX,
} from "./textEffect";
import { MAX_TEXT_GLOW_BLUR_PX } from "./textGlow";
import { McpFormatFieldsSchema } from "./mcpFormatEditing";
import { ConditionalBatchSchemeDraftV2Schema } from "./conditionalBatchRules";

const color = McpFormatFieldsSchema.shape.textColor.unwrap();
const opacity = z.number().min(0).max(1);
const coordinate = z
  .number()
  .min(MIN_BLOCK_LOCAL_COORDINATE)
  .max(MAX_BLOCK_LOCAL_COORDINATE);
const point = z.object({ x: coordinate, y: coordinate }).strict();
const effect = z
  .object({
    enabled: z.boolean(),
    color,
    offsetXpx: z
      .number()
      .min(MIN_TEXT_EFFECT_OFFSET_PX)
      .max(MAX_TEXT_EFFECT_OFFSET_PX),
    offsetYpx: z
      .number()
      .min(MIN_TEXT_EFFECT_OFFSET_PX)
      .max(MAX_TEXT_EFFECT_OFFSET_PX),
    blurPx: z.number().min(0).max(MAX_TEXT_EFFECT_BLUR_PX),
    opacity,
  })
  .strict();
const glow = z
  .object({
    enabled: z.boolean(),
    color,
    blurPx: z.number().min(0).max(MAX_TEXT_GLOW_BLUR_PX),
    opacity,
  })
  .strict();
const perspective = z
  .object({
    version: z.literal(1),
    corners: z.tuple([point, point, point, point]),
  })
  .strict();
const warp = z
  .object({
    version: z.literal(1),
    gridSize: z.union([z.literal(3), z.literal(5)]),
    points: z.array(point).min(16).max(36),
  })
  .strict();
const curve = z
  .object({
    version: z.literal(1),
    path: z
      .object({
        type: z.literal("quadratic"),
        start: point,
        control: point,
        end: point,
      })
      .strict(),
    alignment: z.enum(["start", "center", "end"]),
    offsetEm: z.number().min(MIN_CURVE_OFFSET_EM).max(MAX_CURVE_OFFSET_EM),
    orientation: z.enum(["tangent", "upright"]),
    reversed: z.boolean().optional(),
    fitSpacing: z.boolean().optional(),
  })
  .strict();
/** The transport uses Zod 4; existing native Zod 3 validators remain authoritative.
 * This structural descriptor makes inputs discoverable, then invokes native safety checks. */
export const McpLetteringAdvancedSchema = z
  .object({
    textEffect: effect.nullable().optional(),
    textGlow: glow.nullable().optional(),
    perspectiveTransform: perspective.nullable().optional(),
    warpTransform: warp.nullable().optional(),
    curveLayout: curve.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of Object.keys(value) as (keyof typeof value)[]) {
      if (value[key] === null) continue;
      const result = TranslationBlockObjectSchema.shape[key].safeParse(
        value[key],
      );
      if (!result.success)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Value violates the existing app typography contract.",
        });
    }
  });
export function parseMcpLetteringRule(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("Lettering rule must be a JSON object.", {
        cause: error,
      });
    throw error;
  }
  return ConditionalBatchSchemeDraftV2Schema.parse(value);
}
