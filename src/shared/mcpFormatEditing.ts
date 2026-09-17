import { z } from "zod/v4";
import { McpEditableFieldsSchema, McpBlockPatchSchema } from "./mcpBlockEditing";
import { readConditionalBatchField } from "./conditionalBatchFieldRegistry";
import type { MangaPage } from "./libraryTypes";
import type { TranslationBlock } from "./textTypes";

/** Formatting is separate from dialogue, review labels and inpainting settings. */
export const McpFormatFieldsSchema = McpEditableFieldsSchema.omit({
  sourceText: true, translatedText: true, inpaintExcluded: true,
  reviewStatus: true, reviewNote: true, textRole: true,
});
export type McpFormatFields = z.infer<typeof McpFormatFieldsSchema>;
const keys = Object.keys(McpFormatFieldsSchema.shape) as (keyof McpFormatFields)[];
const condition = z.object({
  field: McpFormatFieldsSchema.keyof(),
  operator: z.enum(["equals", "notEquals", "lt", "lte", "gt", "gte"]),
  value: z.union([z.string().max(120), z.number().finite(), z.boolean()]),
}).strict().superRefine((item, ctx) => {
  if (!McpFormatFieldsSchema.shape[item.field].safeParse(item.value).success)
    ctx.addIssue({ code: "custom", message: "Value must match this format field.", path: ["value"] });
  if (!["equals", "notEquals"].includes(item.operator) && typeof item.value !== "number")
    ctx.addIssue({ code: "custom", message: "Ordered comparisons require a numeric field." });
});
export const McpFormatFilterSchema = z.object({
  basis: z.enum(["stored", "effective"]).default("effective"),
  conditions: z.array(condition).min(1).max(20),
  manualFontSize: z.enum(["all", "only", "exclude"]).default("all"),
}).strict();
export type McpFormatFilter = z.infer<typeof McpFormatFilterSchema>;
const rect = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).strict();
export const McpFormatViewSchema = z.object({
  stored: McpFormatFieldsSchema,
  effective: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  fontSizeIntent: z.enum(["source-match", "manual"]).nullable(),
  fontWeight: z.number().nullable(),
  outlineWidthScale: z.number().nullable(),
  layoutIntent: z.enum(["auto", "horizontal", "vertical"]).nullable(),
  layoutIntentSuppressed: z.boolean(),
  renderBbox: rect.nullable(),
  renderBboxSpace: z.enum(["pixels", "normalized_1000"]).nullable(),
}).strict();

/** Same values as the app conditional editor, not measured final rendered font sizes. */
export function projectMcpFormat(page: MangaPage, block: TranslationBlock) {
  const stored = Object.fromEntries(keys.filter((key) => block[key] !== undefined)
    .map((key) => [key, block[key]])) as McpFormatFields;
  const effective = Object.fromEntries(keys.map((key) => [key,
    readConditionalBatchField(block, key, { page, pageIndex: 0, blockIndex: 0 }),
  ]).filter(([, value]) => value !== undefined));
  return {
    stored, effective,
    fontSizeIntent: block.fontSizeIntent ?? null,
    fontWeight: block.fontWeight ?? null,
    outlineWidthScale: block.outlineWidthScale ?? null,
    layoutIntent: block.layoutIntent ?? null,
    layoutIntentSuppressed: Boolean(block.layoutIntentSuppressed),
    renderBbox: block.renderBbox ? { ...block.renderBbox } : null,
    renderBboxSpace: block.renderBboxSpace ?? null,
  };
}
export function matchesMcpFormat(page: MangaPage, block: TranslationBlock, filter?: McpFormatFilter) {
  if (!filter) return true;
  const manual = block.fontSizeIntent === "manual";
  if (filter.manualFontSize !== "all" && manual !== (filter.manualFontSize === "only")) return false;
  return filter.conditions.every((item) => {
    const actual = filter.basis === "stored" ? block[item.field] :
      readConditionalBatchField(block, item.field, { page, pageIndex: 0, blockIndex: 0 });
    return compareFormatValue(actual, item.operator, item.value);
  });
}
function compareFormatValue(actual: unknown, operator: McpFormatFilter["conditions"][number]["operator"], expected: string | number | boolean) {
  // Absent stored values do not satisfy even notEquals. Use effective for defaults.
  if (actual === undefined) return false;
  if (operator === "equals") return actual === expected;
  if (operator === "notEquals") return actual !== expected;
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  switch (operator) {
    case "lt": return actual < expected;
    case "lte": return actual <= expected;
    case "gt": return actual > expected;
    case "gte": return actual >= expected;
  }
}
export const McpFormatEditSchema = McpBlockPatchSchema.shape.edits.element
  .extend({ fields: McpFormatFieldsSchema.optional(), reason: z.string().trim().min(1).max(500) });
