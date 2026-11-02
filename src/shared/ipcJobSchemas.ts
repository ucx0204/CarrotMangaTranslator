import { imageRedactionReviewSchema } from "./imageRedaction";
import { regionTextReviewSchema } from "./regionTextReview";
import { soundEffectTextReviewSchema } from "./soundEffectTextReview";
import { codexProgressSchema } from "./codexTypesettingProgress";
/* eslint-disable max-lines -- bounded job request variants stay together for schema contract review */
import { z } from "zod";
import { codexTypesettingOptionsSchema } from "./codexTypesettingSchemas";
import {
  JOB_PROGRESS_TEXT_LIMIT,
  JOB_DETAIL_TEXT_LIMIT,
  JOB_INSTALL_LOG_LINES_LIMIT,
  JobKindSchema,
  JobPhaseSchema,
  JobStatusSchema,
  ProgressModeSchema,
  ResearchJobStageSchema,
} from "./jobContracts";
import {
  MAX_MASK_STROKES,
  MAX_ID_LIST_LENGTH,
  MAX_BLOCKS_PER_PAGE,
  MAX_RETAINED_INPAINTING_ARTIFACTS,
  MAX_STROKE_POINTS,
  BBoxSchema,
  TranslationBlockObjectSchema,
  filePath,
  finiteNumber,
  hexColor,
  uuid,
} from "./ipcSchemaPrimitives";
import type { PageRevision } from "./pageRevisionTypes";
import { PageTimingSessionFields } from "./ipcPageTimingSchemas";
import { OCR_PIPELINES } from "./ocrEngines";
import { MAX_PAGE_EXPORT_PAGES } from "./pageExportLimits";

const JobProgressFieldsSchema = {
  phase: JobPhaseSchema.optional(),
  ocrPipeline: z.enum(OCR_PIPELINES).optional(),
  progressMode: ProgressModeSchema.optional(),
  progressPercent: finiteNumber.min(0).max(1).optional(),
  progressBytes: finiteNumber.min(0).optional(),
  progressTotalBytes: finiteNumber.min(0).optional(),
  progressBytesPerSecond: finiteNumber.min(0).optional(),
  installLogLine: z.string().max(JOB_DETAIL_TEXT_LIMIT).optional(),
  notification: z
    .object({
      variant: z.enum(["success", "error", "warn", "info"]),
      message: z.string().min(1).max(JOB_PROGRESS_TEXT_LIMIT),
    })
    .strict()
    .optional(),
};

const PageJobTargetSnapshotSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    revision: z
      .string()
      .regex(/^page-v1:[0-9a-f]{16}$/)
      .transform((value) => value as PageRevision),
  })
  .strict();

export const JobEventSchema = z
  .object({
    regionRequestId: z.string().uuid().optional(),
    regionTextReview: regionTextReviewSchema.optional(),
    soundEffectTextReview: soundEffectTextReviewSchema.optional(),
    imageRedactionReview: imageRedactionReviewSchema.optional(),
    id: z.string().min(1).max(200),
    executionId: z.string().uuid().optional(),
    kind: JobKindSchema,
    status: JobStatusSchema,
    origin: z.literal("mcp").optional(),
    progressText: z.string().min(1).max(JOB_PROGRESS_TEXT_LIMIT),
    detail: z.string().max(JOB_DETAIL_TEXT_LIMIT).optional(),
    ...JobProgressFieldsSchema,
    installLogLines: z
      .array(z.string().max(JOB_DETAIL_TEXT_LIMIT))
      .max(JOB_INSTALL_LOG_LINES_LIMIT)
      .optional(),
    progressCurrent: finiteNumber.min(0).optional(),
    progressTotal: finiteNumber.min(0).optional(),
    workflowProgress: z
      .object({
        pageCount: z.number().int().positive(),
        stageCount: z.number().int().positive(),
        chapterId: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    pageIndex: finiteNumber.min(0).optional(),
    pageTotal: finiteNumber.min(0).optional(),
    attempt: finiteNumber.min(0).optional(),
    attemptTotal: finiteNumber.min(0).optional(),
    pageElapsedMs: finiteNumber.min(0).optional(),
    jobElapsedMs: finiteNumber.min(0).optional(),
    failureGuidance: z
      .enum([
        "increase-max-output-tokens",
        "increase-work-context-budget",
        "increase-context-length",
      ])
      .optional(),
    codexProgress: codexProgressSchema.optional(),
    research: z
      .object({
        stage: ResearchJobStageSchema,
        query: z.string().max(1000).optional(),
        queryIndex: finiteNumber.min(1).optional(),
        resultCount: finiteNumber.min(0).optional(),
        creditsUsed: finiteNumber.min(0).optional(),
        creditLimit: finiteNumber.min(0).optional(),
      })
      .strict()
      .optional(),
    targets: z
      .array(PageJobTargetSnapshotSchema)
      .max(MAX_ID_LIST_LENGTH)
      .optional(),
  })
  .strict();

export const ModelTestProgressEventSchema = z
  .object({
    id: z.string().min(1).max(200),
    progressText: z.string().min(1).max(JOB_PROGRESS_TEXT_LIMIT),
    detail: z.string().max(JOB_DETAIL_TEXT_LIMIT).optional(),
    ...JobProgressFieldsSchema,
  })
  .strict();

const AnalysisBlockModeSchema = z.enum(["auto", "keep"]);
const TranslationCompletionWorkflowSchema = z.enum([
  "erase-original",
  "bubble-layout",
]);

const TranslationRunOptionFields = {
  blockMode: AnalysisBlockModeSchema.optional(),
  collectPageContext: z.boolean().optional(),
  cumulativeContextDetail: z
    .enum(["detailed", "balanced", "essential"])
    .optional(),
  naturalTextLayout: z.boolean().optional(),
  codexTypesetting: codexTypesettingOptionsSchema.optional(),
  autoFontMatching: z.boolean().optional(),
  aiFontSizeMatching: z.boolean().optional(),
  fontSizeAutoFit: z.boolean().optional(),
  completionWorkflow: TranslationCompletionWorkflowSchema.optional(),
  ...PageTimingSessionFields,
};

export const StartAnalysisRequestSchema = z
  .discriminatedUnion("runMode", [
    z
      .object({
        chapterId: uuid,
        runMode: z.literal("pending"),
        ...TranslationRunOptionFields,
      })
      .strict(),
    z
      .object({
        chapterId: uuid,
        runMode: z.literal("all"),
        ...TranslationRunOptionFields,
      })
      .strict(),
    z
      .object({
        chapterId: uuid,
        runMode: z.literal("single-page"),
        pageId: uuid,
        ...TranslationRunOptionFields,
      })
      .strict(),
    z
      .object({
        chapterId: uuid,
        runMode: z.literal("page-set"),
        pageIds: z
          .array(uuid)
          .min(1)
          .max(MAX_ID_LIST_LENGTH)
          .refine(
            (pageIds) => new Set(pageIds).size === pageIds.length,
            "중복된 페이지 ID가 있습니다.",
          ),
        restartPageIds: z
          .array(uuid)
          .max(MAX_ID_LIST_LENGTH)
          .refine(
            (pageIds) => new Set(pageIds).size === pageIds.length,
            "중복된 재번역 페이지 ID가 있습니다.",
          )
          .optional(),
        ...TranslationRunOptionFields,
      })
      .strict(),
  ])
  .superRefine((request, context) => {
    if (request.runMode !== "page-set" || !request.restartPageIds) return;
    const included = new Set(request.pageIds);
    request.restartPageIds.forEach((pageId, index) => {
      if (!included.has(pageId)) {
        context.addIssue({
          code: "custom",
          message: "재번역 페이지는 선택된 페이지에 포함되어야 합니다.",
          path: ["restartPageIds", index],
        });
      }
    });
  });

const InpaintingPointSchema = z
  .object({ x: finiteNumber, y: finiteNumber })
  .strict();
const InpaintingMaskStrokeSchema = z
  .object({
    points: z.array(InpaintingPointSchema).min(1).max(MAX_STROKE_POINTS),
    radiusPx: finiteNumber.min(1).max(512),
  })
  .strict();
export const InpaintingRetouchGeometrySchema = z.discriminatedUnion("kind", [
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
      pageIds: z
        .array(uuid)
        .min(1)
        .max(MAX_ID_LIST_LENGTH)
        .refine(
          (pageIds) => new Set(pageIds).size === pageIds.length,
          "pageIds must be unique",
        ),
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
      ...PageTimingSessionFields,
    })
    .strict(),
  z
    .object({
      chapterId: uuid,
      mode: z.literal("page-bubble-layout"),
      pageId: uuid,
      blockId: TranslationBlockObjectSchema.shape.id.optional(),
      blockIds: z
        .array(TranslationBlockObjectSchema.shape.id)
        .min(1)
        .max(MAX_BLOCKS_PER_PAGE)
        .optional(),
      paddingRatio: finiteNumber.min(0).max(0.7).optional(),
      policy: z.enum(["safe", "balanced", "maximize"]),
      postprocess: InpaintingPostprocessOptionsSchema.optional(),
      ...PageTimingSessionFields,
    })
    .strict()
    .refine(
      (request) =>
        !(request.blockId !== undefined && request.blockIds !== undefined) &&
        (!request.blockIds ||
          new Set(request.blockIds).size === request.blockIds.length),
      { message: "Choose one unique block selection." },
    ),
  z
    .object({
      chapterId: uuid,
      mode: z.literal("page-pattern"),
      engine: z.literal("codex").optional(),
      pageId: uuid,
      blockId: TranslationBlockObjectSchema.shape.id.optional(),
      postprocess: InpaintingPostprocessOptionsSchema.optional(),
      ...PageTimingSessionFields,
    })
    .strict(),
  z
    .object({
      chapterId: uuid,
      mode: z.literal("page-pattern-drawn"),
      engine: z.literal("codex").optional(),
      pageId: uuid,
      strokes: z.array(InpaintingMaskStrokeSchema).min(1).max(MAX_MASK_STROKES),
      featherPx: finiteNumber.min(0).max(128).optional(),
      postprocess: InpaintingPostprocessOptionsSchema.optional(),
      ...PageTimingSessionFields,
    })
    .strict(),
  z
    .object({
      mode: z.literal("selection-pattern"),
      engine: z.literal("codex").optional(),
      workId: uuid,
      selections: z.array(AutoInpaintingChapterSelectionSchema).min(1).max(1),
      postprocess: InpaintingPostprocessOptionsSchema.optional(),
      ...PageTimingSessionFields,
    })
    .strict(),
]);

export const InpaintingRetouchRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    expectedRevision: PageJobTargetSnapshotSchema.shape.revision,
    mode: z.enum(["paint", "restore", "clone", "heal"]),
    geometry: z.union([
      InpaintingRetouchGeometrySchema,
      z
        .object({
          kind: z.literal("stroke"),
          points: z.array(InpaintingPointSchema).min(1).max(32768),
          radiusPx: finiteNumber.min(1).max(512),
        })
        .strict(),
    ]),
    color: hexColor.optional(),
    requestId: uuid.optional(),
    sampled: z
      .object({
        source: z.enum(["current", "original"]),
        offset: z
          .object({
            x: finiteNumber.int().min(-120000000).max(120000000),
            y: finiteNumber.int().min(-120000000).max(120000000),
          })
          .strict(),
        opacity: finiteNumber.min(0).max(1),
        hardness: finiteNumber.min(0).max(1),
      })
      .strict()
      .optional(),
    retainedInpaintedArtifactPaths: z
      .array(filePath)
      .max(MAX_RETAINED_INPAINTING_ARTIFACTS)
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const sampled = request.mode === "clone" || request.mode === "heal";
    if (
      sampled &&
      (!request.sampled ||
        !request.requestId ||
        request.geometry.kind !== "stroke")
    )
      context.addIssue({
        code: "custom",
        message: "Sampled retouch requires stroke, settings and requestId.",
      });
    if (
      !sampled &&
      request.geometry.kind === "stroke" &&
      request.geometry.points.length > MAX_STROKE_POINTS
    )
      context.addIssue({ code: "custom", message: "Too many stroke points." });
    if (!sampled && (request.sampled || request.requestId))
      context.addIssue({
        code: "custom",
        message: "Sample settings are only valid for clone/heal.",
      });
  });

export const SetPageInpaintingResultRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    expectedRevision: PageJobTargetSnapshotSchema.shape.revision,
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
      pageIds: z.array(uuid).min(1).max(MAX_PAGE_EXPORT_PAGES),
    })
    .strict(),
]);

export const PageImageExportRequestSchema = z
  .object({
    workId: uuid,
    selections: z
      .array(PageImageExportChapterSelectionSchema)
      .min(1)
      .max(MAX_PAGE_EXPORT_PAGES),
    expectedTargets: z
      .array(PageJobTargetSnapshotSchema)
      .min(1)
      .max(MAX_PAGE_EXPORT_PAGES)
      .optional(),
    omitText: z.boolean().optional(),
    outputFormat: z.enum(["source", "png", "jpeg", "webp"]).optional(),
    jpegQuality: z.number().int().min(1).max(100).optional(),
    webpQuality: z.number().int().min(1).max(100).optional(),
    preserveSourceNames: z.boolean().optional(),
    destinationMode: z.enum(["timestamped", "fixed"]).optional(),
    collisionPolicy: z.enum(["replace", "skip", "cancel"]).optional(),
  })
  .strict();

export const PagePsdExportRequestSchema = z
  .object({
    workId: uuid,
    selections: z
      .array(PageImageExportChapterSelectionSchema)
      .min(1)
      .max(MAX_PAGE_EXPORT_PAGES),
    expectedTargets: z
      .array(PageJobTargetSnapshotSchema)
      .min(1)
      .max(MAX_PAGE_EXPORT_PAGES)
      .optional(),
    omitText: z.boolean().optional(),
    collisionPolicy: z.enum(["replace", "skip", "cancel"]).optional(),
  })
  .strict();

export const PageImageExportPreflightRequestSchema = z.union([
  PageImageExportRequestSchema,
  PagePsdExportRequestSchema.extend({
    outputFormat: z.literal("psd"),
  }).strict(),
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
    textReviewSessionId: z.string().uuid().optional(),
    eraseOriginal: z.boolean().optional(),
    codexTypesetting: codexTypesettingOptionsSchema.optional(),
    pageRevision: z.string().min(1).max(200).optional(),
    chapterId: uuid,
    pageId: uuid,
    bbox: BBoxSchema,
  })
  .strict();

export const StartSoundEffectTranslationRequestSchema = z
  .object({
    resumeImageRunId: uuid.optional(),
    chapterId: uuid,
    targets: z
      .array(
        z
          .object({
            pageId: uuid,
            pageRevision: z.string().regex(/^page-v1:[0-9a-f]{16}$/),
            regionIds: z
              .array(z.string().min(1).max(80))
              .min(1)
              .max(MAX_BLOCKS_PER_PAGE)
              .refine((ids) => new Set(ids).size === ids.length)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ID_LIST_LENGTH)
      .refine(
        (targets) =>
          new Set(targets.map((target) => target.pageId)).size ===
          targets.length,
      ),
    inpaintAfterTranslation: z.boolean(),
    codexTypesetting: codexTypesettingOptionsSchema.optional(),
    autoFontMatching: z.boolean().optional(),
  })
  .strict();

export const SoundEffectImageRecoverySchema = z
  .object({
    runId: uuid,
    chapterId: uuid,
    targets: z.array(
      z.object({ pageId: uuid, pageRevision: z.string() }).strict(),
    ),
    blockCount: z.number().int().nonnegative(),
    eraseOriginal: z.boolean(),
    output: z.enum(["text", "image"]),
  })
  .strict()
  .nullable();
