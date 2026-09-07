import { z } from "zod";
import { BBoxSchema } from "./ipcSchemaPrimitives";

const regionId = z.string().min(1).max(240);
export const regionTextReviewSchema = z
  .object({
    sessionId: z.string().uuid(),
    regions: z
      .array(
        z
          .object({
            id: regionId,
            sourceText: z.string().max(8000),
            translatedText: z.string().max(8000),
            sourceBbox: BBoxSchema,
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();
export const confirmRegionTranslationSchema = z
  .object({
    jobId: z.string().min(1).max(200),
    sessionId: z.string().uuid(),
    translations: z
      .array(
        z
          .object({
            regionId,
            text: z.string().trim().min(1).max(8000),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();
export type RegionTextReview = z.infer<typeof regionTextReviewSchema>;
export type ConfirmRegionTranslationRequest = z.infer<
  typeof confirmRegionTranslationSchema
>;
