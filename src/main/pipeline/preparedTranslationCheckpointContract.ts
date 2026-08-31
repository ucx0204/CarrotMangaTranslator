import { z } from "zod";
import {
  BBoxSchema,
  MAX_BLOCKS_PER_PAGE,
  TranslationBlockSchema,
  finiteNumber,
} from "../../shared/ipcSchemaPrimitives";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import {
  TRANSLATION_CHECKPOINT_PIPELINE_CONTRACT,
  TRANSLATION_CHECKPOINT_SCHEMA_VERSION,
} from "../../shared/translationCheckpoint";

export const MAX_TRANSLATION_CHECKPOINT_BYTES = 8 * 1024 * 1024;

const BoundedText = z.string().max(20_000);
const CandidateIdSchema = z.number().int().min(0).max(1_000_000);
const CandidateMembershipSchema = z
  .object({
    contractVersion: z.literal("font-matching-ocr-candidate-membership-v2"),
    source: z.enum([
      "semantic_ocr_fixed_block_request_v5",
      "semantic_ocr_fixed_block_request_v6",
      "sealed_font_input_request_block_v2",
    ]),
    bindingId: z.string().min(1).max(1_000),
    originalCandidateIds: z.array(CandidateIdSchema).max(2_000),
    voterCandidateIds: z.array(CandidateIdSchema).max(2_000),
  })
  .strict();
const SourceFontLineGeometrySchema = z
  .object({
    contractVersion: z.literal("source-font-line-geometry-v1"),
    source: z.literal("ocr-geometry-lock"),
    lines: z
      .array(
        z
          .object({
            candidateId: CandidateIdSchema,
            bbox: BBoxSchema,
            sourceText: BoundedText,
          })
          .strict(),
      )
      .max(2_000),
  })
  .strict();
const OverlayItemSchema = z
  .object({
    id: z.number().int().min(0).max(1_000_000),
    candidateIds: z.array(CandidateIdSchema).max(2_000).optional(),
    sourceCandidateMembership: CandidateMembershipSchema.optional(),
    sourceFontLineGeometry: SourceFontLineGeometrySchema.optional(),
    type: z.string().min(1).max(100),
    textRole: z.string().max(100).optional(),
    fontRole: z.string().max(100).optional(),
    fontRoleConfidence: finiteNumber.min(0).max(1).optional(),
    visualClusterId: z.string().max(200).optional(),
    bbox: BBoxSchema,
    jp: BoundedText,
    ko: BoundedText,
    sourceText: BoundedText.optional(),
    translatedText: BoundedText.optional(),
    layoutIntent: z.enum(["auto", "horizontal", "vertical"]).optional(),
    direction: z.enum(["horizontal", "vertical"]).optional(),
    angle: finiteNumber.optional(),
    fontSize: finiteNumber.nullable().optional(),
    confidence: finiteNumber.nullable().optional(),
  })
  .strict();

const PreviousBlockSchema = z
  .object({
    previousId: z.string().min(1).max(200),
    index: z.number().int().min(0).max(MAX_BLOCKS_PER_PAGE),
    candidateId: z.number().int().min(0).optional(),
    bbox: BBoxSchema,
    textRole: z.string().max(100).optional(),
    sourceText: BoundedText,
    translatedText: BoundedText,
    confidence: finiteNumber.optional(),
  })
  .strict();

const PageContextSchema = z
  .object({
    visualSummary: BoundedText.optional(),
    glossary: z
      .array(
        z
          .object({
            source: BoundedText,
            target: BoundedText,
            category: z.enum([
              "character",
              "alias",
              "place",
              "term",
              "honorific",
              "other",
            ]),
            aliases: z.array(BoundedText).max(100).optional(),
            note: BoundedText.optional(),
          })
          .strict(),
      )
      .max(1_000),
    characters: z
      .array(
        z
          .object({
            displayName: BoundedText,
            sourceNames: z.array(BoundedText).max(100),
            targetName: BoundedText,
            aliases: z.array(BoundedText).max(100).optional(),
            speechStyle: z
              .enum([
                "neutral",
                "polite",
                "casual",
                "rough",
                "childish",
                "elderly",
                "formal",
                "custom",
              ])
              .optional(),
            customSpeechStyle: BoundedText.optional(),
            note: BoundedText.optional(),
          })
          .strict(),
      )
      .max(300),
  })
  .strict();

const ReadyPayloadSchema = z
  .object({
    kind: z.literal("ready"),
    resultKind: z.enum(["completed", "no-text"]),
    blocks: z.array(TranslationBlockSchema).max(MAX_BLOCKS_PER_PAGE),
    blockOrder: z
      .array(z.string().min(1).max(200))
      .max(MAX_BLOCKS_PER_PAGE)
      .optional(),
    warnings: z.array(BoundedText).max(1_000),
    detail: BoundedText.optional(),
    pageContext: PageContextSchema.optional(),
  })
  .strict();

const TranslatedPayloadSchema = z
  .object({
    kind: z.literal("translated"),
    jobId: z.string().min(1).max(200),
    items: z.array(OverlayItemSchema).max(MAX_BLOCKS_PER_PAGE),
    fontInferenceItems: z.array(OverlayItemSchema).max(MAX_BLOCKS_PER_PAGE),
    keepBlocksInferenceBlocks: z
      .array(
        z
          .object({
            blockId: z.string().min(1).max(200),
            item: OverlayItemSchema,
          })
          .strict(),
      )
      .max(MAX_BLOCKS_PER_PAGE)
      .optional(),
    previousBlocks: z
      .array(PreviousBlockSchema)
      .max(MAX_BLOCKS_PER_PAGE)
      .optional(),
    soundDroppedCount: z.number().int().min(0).max(MAX_BLOCKS_PER_PAGE),
    validationDroppedCount: z.number().int().min(0).max(MAX_BLOCKS_PER_PAGE),
    validationReasons: z.record(z.string().max(200), z.number().int().min(0)),
    omittedCandidateIds: z.array(z.number().int().min(0)).max(2_000).optional(),
    remappedCount: z.number().int().min(0).max(MAX_BLOCKS_PER_PAGE).optional(),
    contextWarnings: z.array(BoundedText).max(1_000),
    pageContext: PageContextSchema.optional(),
  })
  .strict();

export const PreparedTranslationCheckpointSchema = z
  .object({
    schemaVersion: z.literal(TRANSLATION_CHECKPOINT_SCHEMA_VERSION),
    pipelineContractVersion: z.literal(
      TRANSLATION_CHECKPOINT_PIPELINE_CONTRACT,
    ),
    pageId: z.string().min(1).max(200),
    inputRevision: z
      .string()
      .regex(/^page-v1:[0-9a-f]+$/)
      .transform((value) => value as PageRevision),
    sourceLanguage: z.string().min(1).max(40),
    targetLanguage: z.string().min(1).max(40),
    blockMode: z.enum(["auto", "keep"]),
    savedAt: z.string().datetime(),
    translationDurationMs: z.number().int().min(0).max(604_800_000),
    prepared: z.discriminatedUnion("kind", [
      ReadyPayloadSchema,
      TranslatedPayloadSchema,
    ]),
  })
  .strict();

export type PreparedTranslationCheckpoint = z.infer<
  typeof PreparedTranslationCheckpointSchema
>;
