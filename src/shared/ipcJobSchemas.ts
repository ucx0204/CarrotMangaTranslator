import { z } from "zod";
import {
  JobKindSchema,
  JobPhaseSchema,
  JobStatusSchema,
  ProgressModeSchema,
} from "./jobContracts";
import {
  MAX_MASK_STROKES,
  MAX_RETAINED_INPAINTING_ARTIFACTS,
  MAX_STROKE_POINTS,
  BBoxSchema,
  filePath,
  finiteNumber,
  hexColor,
  uuid,
} from "./ipcSchemaPrimitives";

const JobProgressFieldsSchema = {
  phase: JobPhaseSchema.optional(),
  progressMode: ProgressModeSchema.optional(),
  progressPercent: finiteNumber.min(0).max(1).optional(),
  progressBytes: finiteNumber.min(0).optional(),
  progressTotalBytes: finiteNumber.min(0).optional(),
  progressBytesPerSecond: finiteNumber.min(0).optional(),
  installLogLine: z.string().max(4000).optional(),
};

export const JobEventSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: JobKindSchema,
    status: JobStatusSchema,
    progressText: z.string().min(1).max(1000),
    detail: z.string().max(4000).optional(),
    ...JobProgressFieldsSchema,
    installLogLines: z.array(z.string().max(4000)).max(500).optional(),
    progressCurrent: finiteNumber.min(0).optional(),
    progressTotal: finiteNumber.min(0).optional(),
    pageIndex: finiteNumber.min(0).optional(),
    pageTotal: finiteNumber.min(0).optional(),
    attempt: finiteNumber.min(0).optional(),
    attemptTotal: finiteNumber.min(0).optional(),
  })
  .strict();

export const ModelTestProgressEventSchema = z
  .object({
    id: z.string().min(1).max(200),
    progressText: z.string().min(1).max(1000),
    detail: z.string().max(4000).optional(),
    ...JobProgressFieldsSchema,
  })
  .strict();

const AnalysisBlockModeSchema = z.enum(["auto", "keep"]);

export const StartAnalysisRequestSchema = z.discriminatedUnion("runMode", [
  z
    .object({
      chapterId: uuid,
      runMode: z.literal("pending"),
      blockMode: AnalysisBlockModeSchema.optional(),
    })
    .strict(),
  z
    .object({
      chapterId: uuid,
      runMode: z.literal("all"),
      blockMode: AnalysisBlockModeSchema.optional(),
    })
    .strict(),
  z
    .object({
      chapterId: uuid,
      runMode: z.literal("single-page"),
      pageId: uuid,
      blockMode: AnalysisBlockModeSchema.optional(),
    })
    .strict(),
  z
    .object({
      chapterId: uuid,
      runMode: z.literal("page-set"),
      pageIds: z.array(uuid).min(1),
      blockMode: AnalysisBlockModeSchema.optional(),
    })
    .strict(),
]);

const InpaintingPointSchema = z
  .object({ x: finiteNumber, y: finiteNumber })
  .strict();
const InpaintingMaskStrokeSchema = z
  .object({
    points: z.array(InpaintingPointSchema).min(1).max(MAX_STROKE_POINTS),
    radiusPx: finiteNumber.min(1).max(512),
  })
  .strict();

export const StartInpaintingRequestSchema = z.discriminatedUnion("mode", [
  z
    .object({ chapterId: uuid, mode: z.literal("chapter-pattern-pending") })
    .strict(),
  z
    .object({ chapterId: uuid, mode: z.literal("page-pattern"), pageId: uuid })
    .strict(),
  z
    .object({
      chapterId: uuid,
      mode: z.literal("page-pattern-drawn"),
      pageId: uuid,
      strokes: z.array(InpaintingMaskStrokeSchema).min(1).max(MAX_MASK_STROKES),
      featherPx: finiteNumber.min(0).max(128).optional(),
    })
    .strict(),
]);

export const InpaintingRetouchRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    mode: z.enum(["paint", "restore"]),
    points: z.array(InpaintingPointSchema).min(1).max(MAX_STROKE_POINTS),
    radiusPx: finiteNumber.min(1).max(512),
    color: hexColor.optional(),
    retainedInpaintedArtifactPaths: z
      .array(filePath)
      .max(MAX_RETAINED_INPAINTING_ARTIFACTS)
      .optional(),
  })
  .strict();

export const SetPageInpaintingResultRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    inpaintedImagePath: filePath.nullable().optional(),
    retainedInpaintedArtifactPaths: z
      .array(filePath)
      .max(MAX_RETAINED_INPAINTING_ARTIFACTS)
      .optional(),
  })
  .strict();

export const InpaintingRevertRequestSchema = z.discriminatedUnion("scope", [
  z.object({ chapterId: uuid, scope: z.literal("chapter") }).strict(),
  z
    .object({ chapterId: uuid, scope: z.literal("page"), pageId: uuid })
    .strict(),
]);

export const InpaintingColorSampleRequestSchema = z
  .object({
    imagePath: filePath,
    x: finiteNumber.min(0),
    y: finiteNumber.min(0),
  })
  .strict();

export const InpaintingExportRequestSchema = z.discriminatedUnion("scope", [
  z.object({ chapterId: uuid, scope: z.literal("chapter") }).strict(),
  z
    .object({ chapterId: uuid, scope: z.literal("page"), pageId: uuid })
    .strict(),
]);

export const RendererLogRequestSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string().min(1).max(1000),
    detail: z.unknown().optional(),
  })
  .strict();

export const RegionAnalysisRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    bbox: BBoxSchema,
  })
  .strict();
