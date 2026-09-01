import { z } from "zod";
import { BBoxSchema, MAX_BLOCKS_PER_PAGE, uuid } from "./ipcSchemaPrimitives";
import {
  LEGACY_SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
  LEGACY_SOUND_EFFECT_REVIEW_V2_CONTRACT_VERSION,
  SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
  normalizeSoundEffectReview,
} from "./soundEffectReview";

const SoundEffectReviewRegionSchema = z
  .object({
    id: z.string().min(1).max(80),
    bbox: BBoxSchema,
    detectorConfidence: z.number().finite().min(0).max(1),
    recognizedText: z.string().max(2000).optional(),
    sourceDetectionIds: z.array(z.string().min(1).max(80)).max(32).optional(),
  })
  .strict();

const LegacyDismissedSoundEffectRegionIdsSchema = z
  .array(z.string().min(1).max(80))
  .max(MAX_BLOCKS_PER_PAGE)
  .refine((ids) => new Set(ids).size === ids.length)
  .optional();

const SoundEffectReviewV1Schema = z
  .object({
    contractVersion: z.literal(LEGACY_SOUND_EFFECT_REVIEW_CONTRACT_VERSION),
    producer: z.literal("hayai-regions-v1"),
    regions: z.array(SoundEffectReviewRegionSchema).max(MAX_BLOCKS_PER_PAGE),
    dismissedRegionIds: LegacyDismissedSoundEffectRegionIdsSchema,
  })
  .strict();

const SoundEffectReviewV2Schema = z
  .object({
    contractVersion: z.literal(LEGACY_SOUND_EFFECT_REVIEW_V2_CONTRACT_VERSION),
    producer: z.literal("hayai-regions-v1"),
    regions: z.array(SoundEffectReviewRegionSchema).max(MAX_BLOCKS_PER_PAGE),
    resolvedRegions: z
      .array(
        z
          .object({
            regionId: z.string().min(1).max(80),
            blockId: z.string().min(1).max(200),
            resolvedAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(MAX_BLOCKS_PER_PAGE)
      .refine(
        (entries) =>
          new Set(entries.map((entry) => entry.regionId)).size ===
          entries.length,
      ),
    dismissedRegionIds: LegacyDismissedSoundEffectRegionIdsSchema,
  })
  .strict();

const SoundEffectReviewRegionOverrideSchema = z
  .object({
    regionId: z.string().min(1).max(80),
    bbox: BBoxSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

const ManualSoundEffectReviewRegionSchema = z
  .object({
    id: z.string().min(1).max(80),
    bbox: BBoxSchema,
    detectorConfidence: z.literal(1),
    createdAt: z.string().datetime(),
  })
  .strict();

const SoundEffectReviewV3Schema = z
  .object({
    contractVersion: z.literal(SOUND_EFFECT_REVIEW_CONTRACT_VERSION),
    producer: z.literal("hayai-regions-v1"),
    regions: z.array(SoundEffectReviewRegionSchema).max(MAX_BLOCKS_PER_PAGE),
    regionOverrides: z
      .array(SoundEffectReviewRegionOverrideSchema)
      .max(MAX_BLOCKS_PER_PAGE)
      .refine(
        (entries) =>
          new Set(entries.map((entry) => entry.regionId)).size ===
          entries.length,
      ),
    manualRegions: z
      .array(ManualSoundEffectReviewRegionSchema)
      .max(MAX_BLOCKS_PER_PAGE)
      .refine(
        (entries) =>
          new Set(entries.map((entry) => entry.id)).size === entries.length,
      ),
    resolvedRegions: SoundEffectReviewV2Schema.shape.resolvedRegions,
    dismissedRegionIds: LegacyDismissedSoundEffectRegionIdsSchema,
  })
  .strict();

export const SoundEffectReviewSchema = z
  .union([
    SoundEffectReviewV3Schema,
    SoundEffectReviewV2Schema,
    SoundEffectReviewV1Schema,
  ])
  .transform(normalizeSoundEffectReview);

export const DismissSoundEffectReviewRegionRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    regionId: z.string().min(1).max(80),
  })
  .strict();

const SoundEffectReviewDraftRegionSchema = z
  .object({
    regionId: z.string().min(1).max(80),
    bbox: BBoxSchema,
  })
  .strict();

export const PrepareSoundEffectTranslationPageSchema = z
  .object({
    pageId: uuid,
    pageRevision: z.string().regex(/^page-v1:[0-9a-f]{16}$/),
    includedRegionIds: z
      .array(z.string().min(1).max(80))
      .max(MAX_BLOCKS_PER_PAGE)
      .refine((ids) => new Set(ids).size === ids.length),
    editedRegions: z
      .array(SoundEffectReviewDraftRegionSchema)
      .max(MAX_BLOCKS_PER_PAGE)
      .refine(
        (entries) =>
          new Set(entries.map((entry) => entry.regionId)).size ===
          entries.length,
      ),
    addedRegions: z
      .array(SoundEffectReviewDraftRegionSchema)
      .max(MAX_BLOCKS_PER_PAGE)
      .refine(
        (entries) =>
          new Set(entries.map((entry) => entry.regionId)).size ===
          entries.length,
      ),
    dismissedRegionIds: z
      .array(z.string().min(1).max(80))
      .max(MAX_BLOCKS_PER_PAGE)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();

export const PrepareSoundEffectTranslationRequestSchema = z
  .object({
    chapterId: uuid,
    pages: z
      .array(PrepareSoundEffectTranslationPageSchema)
      .min(1)
      .max(MAX_BLOCKS_PER_PAGE)
      .refine(
        (pages) =>
          new Set(pages.map((page) => page.pageId)).size === pages.length,
      ),
  })
  .strict();
