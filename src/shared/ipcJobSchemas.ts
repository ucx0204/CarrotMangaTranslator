import { z } from "zod";
import {
  JobKindSchema,
  JobPhaseSchema,
  JobStatusSchema,
  ProgressModeSchema,
} from "./jobContracts";
import {
  MAX_MASK_STROKES,
  MAX_ID_LIST_LENGTH,
  MAX_RETAINED_INPAINTING_ARTIFACTS,
  MAX_STROKE_POINTS,
  BBoxSchema,
  TranslationBlockSchema,
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
      collectPageContext: z.boolean().optional(),
      naturalTextLayout: z.boolean().optional(),
      autoFontMatching: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      chapterId: uuid,
      runMode: z.literal("all"),
      blockMode: AnalysisBlockModeSchema.optional(),
      collectPageContext: z.boolean().optional(),
      naturalTextLayout: z.boolean().optional(),
      autoFontMatching: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      chapterId: uuid,
      runMode: z.literal("single-page"),
      pageId: uuid,
      blockMode: AnalysisBlockModeSchema.optional(),
      collectPageContext: z.boolean().optional(),
      naturalTextLayout: z.boolean().optional(),
      autoFontMatching: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      chapterId: uuid,
      runMode: z.literal("page-set"),
      pageIds: z.array(uuid).min(1),
      blockMode: AnalysisBlockModeSchema.optional(),
      collectPageContext: z.boolean().optional(),
      naturalTextLayout: z.boolean().optional(),
      autoFontMatching: z.boolean().optional(),
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
const InpaintingRetouchGeometrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("stroke"),
      points: z.array(InpaintingPointSchema).min(1).max(MAX_STROKE_POINTS),
      radiusPx: finiteNumber.min(1).max(512),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rectangle"),
      start: InpaintingPointSchema,
      end: InpaintingPointSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("ellipse"),
      start: InpaintingPointSchema,
      end: InpaintingPointSchema,
    })
    .strict(),
]);

const AutoInpaintingChapterSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ chapterId: uuid, mode: z.literal("all") }).strict(),
  z
    .object({
      chapterId: uuid,
      mode: z.literal("page-set"),
      pageIds: z.array(uuid).min(1).max(MAX_ID_LIST_LENGTH),
    })
    .strict(),
]);

const InpaintingPostprocessOptionsSchema = z
  .object({
    bubbleLayout: z
      .object({
        enabled: z.boolean(),
        policy: z.enum(["safe", "balanced", "maximize"]),
        naturalTextLayout: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const StartInpaintingRequestSchema = z.discriminatedUnion("mode", [
  z
    .object({
      chapterId: uuid,
      mode: z.literal("chapter-pattern-pending"),
      postprocess: InpaintingPostprocessOptionsSchema.optional(),
    })
    .strict(),
  z
    .object({
      chapterId: uuid,
      mode: z.literal("page-bubble-layout"),
      pageId: uuid,
      blockId: TranslationBlockSchema.shape.id.optional(),
      policy: z.enum(["safe", "balanced", "maximize"]),
      postprocess: InpaintingPostprocessOptionsSchema.optional(),
    })
    .strict(),
  z
    .object({
      chapterId: uuid,
      mode: z.literal("page-pattern"),
      pageId: uuid,
      blockId: TranslationBlockSchema.shape.id.optional(),
      postprocess: InpaintingPostprocessOptionsSchema.optional(),
    })
    .strict(),
  z
    .object({
      chapterId: uuid,
      mode: z.literal("page-pattern-drawn"),
      pageId: uuid,
      strokes: z.array(InpaintingMaskStrokeSchema).min(1).max(MAX_MASK_STROKES),
      featherPx: finiteNumber.min(0).max(128).optional(),
      postprocess: InpaintingPostprocessOptionsSchema.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("selection-pattern"),
      workId: uuid,
      selections: z
        .array(AutoInpaintingChapterSelectionSchema)
        .min(1)
        .max(MAX_ID_LIST_LENGTH),
      postprocess: InpaintingPostprocessOptionsSchema.optional(),
    })
    .strict(),
]);

export const InpaintingRetouchRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    mode: z.enum(["paint", "restore"]),
    geometry: InpaintingRetouchGeometrySchema,
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

export const ApplyInpaintingHistoryTransactionRequestSchema = z
  .object({
    transactionId: uuid,
    direction: z.enum(["undo", "redo"]),
  })
  .strict();

export const ReleaseInpaintingHistoryTransactionsRequestSchema = z
  .object({
    transactionIds: z.array(uuid).min(1).max(MAX_ID_LIST_LENGTH),
  })
  .strict();

const PageImageExportChapterSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ chapterId: uuid, mode: z.literal("all") }).strict(),
  z
    .object({
      chapterId: uuid,
      mode: z.literal("page-set"),
      pageIds: z.array(uuid).min(1).max(MAX_ID_LIST_LENGTH),
    })
    .strict(),
]);

export const PageImageExportRequestSchema = z
  .object({
    workId: uuid,
    selections: z
      .array(PageImageExportChapterSelectionSchema)
      .min(1)
      .max(MAX_ID_LIST_LENGTH),
  })
  .strict();

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
