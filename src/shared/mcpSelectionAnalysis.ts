import { z } from "zod/v4";
import { McpSourceRectPatchSchema } from "./mcpSourceRect";
import { McpBlockOcrObservationSchema } from "./mcpBlockOcr";
import { McpBlockTranslationProposalSchema } from "./mcpBlockTranslation";
import {
  isValidLanguageCodeInput,
  MAX_LANGUAGE_CODE_LENGTH,
} from "./translationLanguages";

const { chapterId, pageId, blockId, revision } = McpSourceRectPatchSchema.shape;
const hash = z.string().regex(/^[a-f0-9]{16}$/);
const language = z
  .string()
  .min(1)
  .max(MAX_LANGUAGE_CODE_LENGTH)
  .refine(isValidLanguageCodeInput);
const base = { chapterId, contextRevision: hash, requestId: z.uuid() };
const rectangle = McpSourceRectPatchSchema.shape.sourceRect;
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("block"), blockId }).strict(),
  z
    .object({
      kind: z.literal("region"),
      regionId: blockId,
      sourceRect: rectangle,
    })
    .strict(),
]);
export const McpSelectionOcrSchema = z
  .object({
    ...base,
    sourceLanguage: language.optional(),
    allowAssetDownloads: z.boolean().default(false),
    pages: z
      .array(
        z
          .object({
            pageId,
            revision,
            targets: z.array(target).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export const McpSelectionTranslationSchema = z
  .object({
    ...base,
    contextMode: z.enum(["none", "saved"]).default("saved"),
    sourceLanguage: language.optional(),
    targetLanguage: language.optional(),
    expectedEngine: z.enum(["gemma", "openai-api", "openai-codex"]),
    allowExternal: z.boolean().default(false),
    allowAssetDownloads: z.boolean().default(false),
    preserveExistingTranslations: z.boolean().default(true),
    pages: z
      .array(
        z
          .object({
            pageId,
            revision,
            blockIds: z.array(blockId).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type McpSelectionOcr = z.infer<typeof McpSelectionOcrSchema>;
export type McpSelectionTranslation = z.infer<
  typeof McpSelectionTranslationSchema
>;
export type McpSelectionInput = McpSelectionOcr | McpSelectionTranslation;
export const McpSelectionAnalysisReferenceSchema = z
  .object({
    analysisId: z.uuid(),
    expiresAt: z.number().int().nonnegative(),
    total: z.number().int().min(1).max(100),
    kind: z.enum(["ocr", "translation"]),
  })
  .strict();
export const McpSelectionAnalysisGetSchema = z
  .object({
    analysisId: z.uuid(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();
export const McpSelectionAnalysisItemSchema = z
  .object({
    itemId: blockId,
    pageId,
    revision,
    blockId: blockId.nullable(),
    regionId: blockId.nullable(),
    excludedReason: z.string().nullable(),
    engine: z.string().nullable(),
    ocr: McpBlockOcrObservationSchema.nullable(),
    translation: McpBlockTranslationProposalSchema.nullable(),
    overlaps: z
      .array(
        z
          .object({
            sequence: z.number().int().nonnegative(),
            blockIds: z.array(blockId).max(5000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type McpSelectionAnalysisItem = z.infer<
  typeof McpSelectionAnalysisItemSchema
>;
export const mcpSelectionAnalysisOutputs = {
  carrot_get_selection_analysis: McpSelectionAnalysisReferenceSchema.extend({
    chapterId,
    contextRevision: hash,
    offset: z.number().int(),
    limit: z.number().int(),
    nextOffset: z.number().int().nullable(),
    items: z.array(McpSelectionAnalysisItemSchema).max(10),
    notes: z.array(z.string()),
  }).strict(),
};
