import { z } from "zod";
import {
  regionTextReviewSchema,
  confirmRegionTranslationSchema,
} from "./regionTextReview";

export const soundEffectTextReviewSchema = z
  .object({
    sessionId: z.string().uuid(),
    pages: z
      .array(
        z
          .object({
            pageId: z.string().min(1).max(200),
            name: z.string().max(1000),
            imagePath: z.string().min(1).max(32768),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            review: regionTextReviewSchema,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

export const confirmSoundEffectTextReviewSchema = z
  .object({
    jobId: confirmRegionTranslationSchema.shape.jobId,
    sessionId: confirmRegionTranslationSchema.shape.sessionId,
    pages: z
      .array(
        z
          .object({
            pageId: z.string().min(1).max(200),
            translations: confirmRegionTranslationSchema.shape.translations,
            protection: confirmRegionTranslationSchema.shape.protection,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

export type SoundEffectTextReview = z.infer<typeof soundEffectTextReviewSchema>;
export type ConfirmSoundEffectTextReview = z.infer<
  typeof confirmSoundEffectTextReviewSchema
>;
