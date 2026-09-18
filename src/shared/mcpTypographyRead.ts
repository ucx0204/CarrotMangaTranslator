import { z } from "zod/v4";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.string().regex(/^[a-f0-9]{16}$/);
const count = z.number().int().nonnegative();
const locale = z.enum(["ko", "en", "ja", "zh-Hans", "zh-Hant"]);
export const McpFontListInput = z
  .object({
    query: z.string().max(200).optional(),
    locale: locale.optional(),
    includeHidden: z.boolean().default(false),
    snapshot: revision.optional(),
    offset: count.max(1000000).default(0),
    limit: count.min(1).max(100).default(25),
  })
  .strict();
export const McpFontEntrySchema = z
  .object({
    fontId: id,
    label: z.string().max(200),
    source: z.enum(["built-in", "custom"]),
    availability: z.enum(["available", "unavailable", "unverified"]),
    matchingRole: z.enum(["built-in-candidate", "custom-font", "unavailable"]),
    locales: z.array(locale),
    baseWeight: z.number().int().min(1).max(1000).nullable(),
    baseItalic: z.boolean().nullable(),
    hidden: z.boolean(),
    favorite: z.boolean(),
    defaultFont: z.boolean(),
  })
  .strict();
export const McpFontListOutput = z
  .object({
    snapshot: revision,
    total: count,
    offset: count,
    limit: count,
    nextOffset: count.nullable(),
    fonts: z.array(McpFontEntrySchema).max(100),
    notes: z.array(z.string()),
  })
  .strict();
export const McpTypographyPreflightInput = z
  .object({
    chapterId: id,
    pageIds: z.array(id).min(1).max(50).optional(),
    mode: z.enum(["font", "size", "font-and-size"]),
    sourceLanguage: z.string().min(2).max(32),
    targetLanguage: z.string().min(2).max(32),
    allowOcr: z.boolean().default(false),
    preserveManualFontSize: z.boolean().default(true),
  })
  .strict();
const block = z
  .object({
    blockId: id,
    fontEligible: z.boolean(),
    sizeEligible: z.boolean(),
    fontExclusion: z.string().nullable(),
    sizeExclusion: z.string().nullable(),
    manualFontSize: z.boolean(),
    hasStoredSourceMeasurement: z.boolean(),
  })
  .strict();
export const McpTypographyPreflightOutput = z
  .object({
    chapterId: id,
    snapshot: revision,
    catalogSnapshot: revision,
    mode: McpTypographyPreflightInput.shape.mode,
    sourceLanguage: z.string(),
    targetLanguage: z.string(),
    status: z.enum(["blocked", "inputs_available"]),
    blockers: z.array(z.string()),
    requiredStages: z.array(z.string()),
    requiresOcr: z.boolean(),
    executionReserved: z.literal(false),
    analysisToolAvailable: z.boolean(),
    analysisTool: z.literal("carrot_run_page_source_size").nullable(),
    pages: z
      .array(
        z
          .object({
            pageId: id,
            revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
            pageIndex: count,
            blocks: z.array(block).max(1000),
          })
          .strict(),
      )
      .max(50),
    counts: z
      .object({
        pages: count,
        blocks: count,
        fontEligible: count,
        sizeEligible: count,
      })
      .strict(),
    notChecked: z.array(z.string()),
    notes: z.array(z.string()),
  })
  .strict();
export type McpFontEntry = z.infer<typeof McpFontEntrySchema>;
export type McpTypographyPreflight = z.infer<
  typeof McpTypographyPreflightInput
>;
export const mcpTypographyReadOutputs = {
  carrot_list_fonts: McpFontListOutput,
  carrot_preflight_typography: McpTypographyPreflightOutput,
};
