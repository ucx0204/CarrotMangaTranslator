import { z } from "zod";
import type { RegionEditProtection } from "./regionEditProtectionTypes";
import { BBoxSchema } from "./ipcSchemaPrimitives";
import { letteringMaskStrokesSchema } from "./generatedLetteringMaskSchemas";

const editBbox = BBoxSchema.innerType().refine(
  (box) =>
    box.w > 0 && box.h > 0 && box.x + box.w <= 1000 && box.y + box.h <= 1000,
  "편집 영역이 선택 이미지 밖으로 벗어났습니다.",
);
const editProtectionSchema: z.ZodType<RegionEditProtection> = z
  .object({
    strokes: letteringMaskStrokesSchema.refine((strokes) =>
      strokes.every(
        (stroke) =>
          stroke.space === "page" &&
          stroke.softness === 0 &&
          stroke.points.every(
            (point) =>
              point.x >= 0 &&
              point.x <= 1000 &&
              point.y >= 0 &&
              point.y <= 1000,
          ),
      ),
    ),
    /** Rasterized from the same SVG used by the preview and saved lettering masks. */
    maskDataUrl: z
      .string()
      .max(16_000_000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
    regions: z
      .array(
        z
          .object({
            regionId: z.string().min(1).max(240),
            maskDataUrl: z
              .string()
              .max(16_000_000)
              .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
          })
          .strict(),
      )
      .max(128)
      .refine(
        (regions) =>
          new Set(regions.map((region) => region.regionId)).size ===
            regions.length &&
          regions.reduce(
            (size, region) => size + region.maskDataUrl.length,
            0,
          ) <= 32_000_000,
      )
      .optional(),
  })
  .strict();

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
            styleGroupId: regionId.optional(),
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
    protection: editProtectionSchema.optional(),
    translations: z
      .array(
        z
          .object({
            regionId,
            text: z.string().trim().min(1).max(8000),
            sourceBbox: editBbox.optional(),
            parentRegionId: regionId.optional(),
            excluded: z.boolean().optional(),
            sourceText: z.string().max(8000).optional(),
            styleGroupId: regionId.optional(),
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
