import { McpLetteringResourceCommandSchema } from "./mcpLetteringResources";
import { z } from "zod/v4";
import { McpFormatBatchPreviewSchema } from "./mcpFormatBatch";
import {
  McpFormatFieldsSchema,
  McpFormatFilterSchema,
} from "./mcpFormatEditing";
import { McpLetteringAdvancedSchema } from "./mcpLetteringAdvanced";
import { mcpTranslationBatchOutputs } from "./mcpTranslationBatch";
import {
  DEFAULT_BUBBLE_LAYOUT_PADDING_RATIO,
  MIN_BUBBLE_LAYOUT_PADDING_RATIO,
  MAX_BUBBLE_LAYOUT_PADDING_RATIO,
} from "./bubbleLayoutSettings";
import type { TranslationBlock } from "./textTypes";

const McpLetteringCommandSchema = z.discriminatedUnion("kind", [
  McpLetteringResourceCommandSchema,
  z
    .object({
      kind: z.literal("format"),
      fields: McpFormatFieldsSchema.default({}),
      advanced: McpLetteringAdvancedSchema.default({}),
      filter: McpFormatFilterSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rule"),
      schemeJson: z.string().min(2).max(100000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("layout"),
      mode: z.enum(["geometry", "wrap", "geometry-and-wrap"]),
      policy: z.enum(["safe", "balanced", "maximize"]).default("balanced"),
      paddingRatio: z
        .number()
        .min(MIN_BUBBLE_LAYOUT_PADDING_RATIO)
        .max(MAX_BUBBLE_LAYOUT_PADDING_RATIO)
        .default(DEFAULT_BUBBLE_LAYOUT_PADDING_RATIO),
      preserveManualLayout: z.boolean().default(true),
      preserveExistingLineBreaks: z.boolean().default(true),
      locale: z.enum(["ko", "en", "ja", "zh-Hans", "zh-Hant"]).default("ko"),
      allowAssetDownloads: z.boolean().default(false),
    })
    .strict(),
]);
const target = McpFormatBatchPreviewSchema.shape.pages.element;
export const McpLetteringPrepareSchema = McpFormatBatchPreviewSchema.extend({
  command: McpLetteringCommandSchema,
  pages: z
    .array(
      target.extend({
        edits: z
          .array(
            z
              .object({
                blockId: target.shape.edits.element.shape.blockId,
                reason: z.string().trim().min(1).max(500),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      }),
    )
    .min(1)
    .max(50),
}).strict();
export type McpLetteringPrepare = z.infer<typeof McpLetteringPrepareSchema>;
export type McpLetteringCommand = z.infer<typeof McpLetteringCommandSchema>;
export const MCP_LETTERING_STYLE_KEYS = [
  ...Object.keys(McpFormatFieldsSchema.shape),
  "fontWeight",
  "fontSizeIntent",
  "outlineWidthScale",
  "layoutIntent",
  "layoutIntentSuppressed",
  "textEffect",
  "textGlow",
  "perspectiveTransform",
  "warpTransform",
  "curveLayout",
  "translatedText",
] as const;
const rect = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
  })
  .strict();
/** Summary only; complete exact geometry stays in the owned internal plan. */
const state = z
  .object({
    fields: McpFormatFieldsSchema,
    advanced: McpLetteringAdvancedSchema,
    translatedText: z.string().max(20000),
    fontSizeIntent: z.enum(["manual", "source-match"]).nullable(),
    fontWeight: z.number().nullable(),
    renderBbox: rect.nullable(),
    renderBboxSpace: z.enum(["pixels", "normalized_1000"]).nullable(),
    bubbleLayout: z
      .object({
        origin: z.enum(["detected", "manual"]).nullable(),
        direction: z.enum(["horizontal", "vertical"]),
        regionCount: z.number().int().nonnegative(),
        confidence: z.number().min(0).max(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
export function projectMcpLetteringState(block: TranslationBlock) {
  const select = (keys: readonly string[]) =>
    Object.fromEntries(
      keys
        .filter((key) => block[key as keyof TranslationBlock] !== undefined)
        .map((key) => [key, block[key as keyof TranslationBlock]]),
    );
  return state.parse({
    fields: select(Object.keys(McpFormatFieldsSchema.shape)),
    advanced: select([
      "textEffect",
      "textGlow",
      "perspectiveTransform",
      "warpTransform",
      "curveLayout",
    ]),
    translatedText: block.translatedText,
    fontSizeIntent: block.fontSizeIntent ?? null,
    fontWeight: block.fontWeight ?? null,
    renderBbox: block.renderBbox ?? null,
    renderBboxSpace: block.renderBboxSpace ?? null,
    bubbleLayout: block.bubbleLayout
      ? {
          origin: block.bubbleLayout.origin ?? null,
          direction: block.bubbleLayout.direction,
          regionCount: block.bubbleLayout.regions.length,
          confidence: block.bubbleLayout.confidence,
        }
      : null,
  });
}
export const McpLetteringPlanReferenceSchema = z
  .object({
    batchId: z.string().uuid(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
const change = z
  .object({
    pageId: z.string(),
    blockId: z.string(),
    reason: z.string(),
    before: state,
    after: state,
    changed: z.boolean(),
    excludedReason: z.string().nullable(),
    warnings: z.array(z.string()),
  })
  .strict();
export type McpLetteringChangeView = z.infer<typeof change>;
export const mcpLetteringOutputs = {
  carrot_get_lettering_batch:
    mcpTranslationBatchOutputs.carrot_get_translation_batch.extend({
      changes: z.array(change).max(25),
    }),
  carrot_apply_lettering_batch:
    mcpTranslationBatchOutputs.carrot_apply_translation_batch,
  carrot_undo_lettering_batch:
    mcpTranslationBatchOutputs.carrot_undo_translation_batch,
  carrot_redo_lettering_batch:
    mcpTranslationBatchOutputs.carrot_redo_translation_batch,
  carrot_cancel_lettering_batch:
    mcpTranslationBatchOutputs.carrot_cancel_translation_batch,
};
