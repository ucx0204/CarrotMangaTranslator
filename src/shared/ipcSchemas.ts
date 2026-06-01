import { z } from "zod";

const MAX_TITLE_LENGTH = 240;
const MAX_TEXT_LENGTH = 20000;
const MAX_PATH_LENGTH = 4096;
const MAX_ID_LIST_LENGTH = 2000;
const MAX_PAGES_PER_REQUEST = 2000;
const MAX_BLOCKS_PER_PAGE = 500;
const MAX_STROKE_POINTS = 20000;

const finiteNumber = z.number().finite();
const uuid = z.string().uuid();
const title = z.string().max(MAX_TITLE_LENGTH);
const filePath = z.string().min(1).max(MAX_PATH_LENGTH);
const boundedText = z.string().max(MAX_TEXT_LENGTH);
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i);

export const BBoxSchema = z
  .object({
    x: finiteNumber.min(0).max(1000),
    y: finiteNumber.min(0).max(1000),
    w: finiteNumber.min(1).max(1000),
    h: finiteNumber.min(1).max(1000)
  })
  .strict()
  .superRefine((bbox, context) => {
    if (bbox.x + bbox.w > 1000.0001) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["w"], message: "bbox exceeds normalized page width" });
    }
    if (bbox.y + bbox.h > 1000.0001) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["h"], message: "bbox exceeds normalized page height" });
    }
  });

export const TranslationBlockSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.literal("nonsolid"),
    bbox: BBoxSchema,
    renderBbox: BBoxSchema.optional(),
    bboxSpace: z.enum(["normalized_1000", "pixels"]).optional(),
    renderBboxSpace: z.enum(["normalized_1000", "pixels"]).optional(),
    sourceText: boundedText,
    translatedText: boundedText,
    confidence: finiteNumber.min(0).max(1),
    sourceDirection: z.enum(["horizontal", "vertical"]),
    renderDirection: z.enum(["horizontal", "vertical", "rotated", "hidden"]),
    rotationDeg: finiteNumber.min(-30).max(30).optional(),
    fontFamily: z.string().max(120).optional(),
    fontSizePx: finiteNumber.min(1).max(512),
    lineHeight: finiteNumber.min(0.5).max(4),
    textAlign: z.enum(["left", "center", "right"]),
    textColor: hexColor,
    outlineColor: hexColor.optional(),
    backgroundColor: hexColor,
    opacity: finiteNumber.min(0).max(1),
    autoFitText: z.boolean().optional()
  })
  .strict();

const PageAnalysisStatusSchema = z.enum(["idle", "running", "completed", "failed"]);
const ChapterStatusSchema = z.enum(["idle", "running", "completed", "partial", "failed"]);
const ImportSourceKindSchema = z.enum(["images", "folder", "zip", "zip-folder"]);

export const MangaPageSchema = z
  .object({
    id: uuid,
    name: z.string().min(1).max(260),
    imagePath: filePath,
    inpaintedImagePath: filePath.optional(),
    dataUrl: z.string().max(32 * 1024 * 1024),
    width: z.number().int().min(1).max(100000),
    height: z.number().int().min(1).max(100000),
    blocks: z.array(TranslationBlockSchema).max(MAX_BLOCKS_PER_PAGE),
    analysisStatus: PageAnalysisStatusSchema,
    lastError: z.string().max(4000).optional(),
    createdAt: z.string().max(80),
    updatedAt: z.string().max(80)
  })
  .strict();

export const SaveMangaPageSchema = MangaPageSchema.extend({
  dataUrl: z.literal("")
}).strict();

export const ChapterSnapshotSchema = z
  .object({
    id: uuid,
    workId: uuid,
    title,
    sourceKind: ImportSourceKindSchema,
    status: ChapterStatusSchema,
    pageOrder: z.array(uuid).max(MAX_PAGES_PER_REQUEST),
    pages: z.array(MangaPageSchema).max(MAX_PAGES_PER_REQUEST),
    createdAt: z.string().max(80),
    updatedAt: z.string().max(80)
  })
  .strict();

export const SaveChapterSnapshotSchema = ChapterSnapshotSchema.extend({
  pages: z.array(SaveMangaPageSchema).max(MAX_PAGES_PER_REQUEST)
}).strict();

export const CreateImportRequestSchema = z
  .object({
    previewId: uuid,
    target: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("new"), title }).strict(),
      z.object({ mode: z.literal("existing"), workId: uuid }).strict()
    ]),
    selections: z
      .array(
        z
          .object({
            draftId: uuid,
            title,
            enabled: z.boolean()
          })
          .strict()
      )
      .max(500)
  })
  .strict();

export const WorkShareExportRequestSchema = z
  .object({
    workId: uuid,
    chapterIds: z.array(uuid).min(1).max(MAX_ID_LIST_LENGTH)
  })
  .strict();

export const WorkShareImportRequestSchema = z
  .object({
    previewId: uuid,
    target: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("new"), title }).strict(),
      z.object({ mode: z.literal("existing"), workId: uuid }).strict()
    ]),
    entries: z
      .array(
        z.discriminatedUnion("source", [
          z.object({ source: z.literal("existing"), chapterId: uuid, title }).strict(),
          z.object({ source: z.literal("package"), packageChapterId: z.string().min(1).max(200), title }).strict()
        ])
      )
      .max(MAX_ID_LIST_LENGTH)
  })
  .strict();

export const StartAnalysisRequestSchema = z
  .object({
    chapterId: uuid,
    runMode: z.enum(["pending", "all", "single-page"]),
    pageId: uuid.optional()
  })
  .strict();

export const RegionAnalysisRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    bbox: BBoxSchema
  })
  .strict();

const InpaintingPointSchema = z.object({ x: finiteNumber, y: finiteNumber }).strict();
const InpaintingMaskStrokeSchema = z
  .object({
    points: z.array(InpaintingPointSchema).min(1).max(MAX_STROKE_POINTS),
    radiusPx: finiteNumber.min(1).max(512)
  })
  .strict();

export const StartInpaintingRequestSchema = z.discriminatedUnion("mode", [
  z.object({ chapterId: uuid, mode: z.literal("chapter-pattern") }).strict(),
  z.object({ chapterId: uuid, mode: z.literal("page-pattern"), pageId: uuid }).strict(),
  z
    .object({
      chapterId: uuid,
      mode: z.literal("page-pattern-drawn"),
      pageId: uuid,
      strokes: z.array(InpaintingMaskStrokeSchema).min(1).max(2000),
      featherPx: finiteNumber.min(0).max(128).optional()
    })
    .strict()
]);

export const InpaintingRetouchRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    mode: z.enum(["paint", "restore"]),
    points: z.array(InpaintingPointSchema).min(1).max(MAX_STROKE_POINTS),
    radiusPx: finiteNumber.min(1).max(512),
    color: hexColor.optional()
  })
  .strict();

export const SetPageInpaintingResultRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    inpaintedImagePath: filePath.nullable().optional()
  })
  .strict();

export const InpaintingRevertRequestSchema = z.discriminatedUnion("scope", [
  z.object({ chapterId: uuid, scope: z.literal("chapter") }).strict(),
  z.object({ chapterId: uuid, scope: z.literal("page"), pageId: uuid }).strict()
]);

export const InpaintingColorSampleRequestSchema = z
  .object({
    imagePath: filePath,
    x: finiteNumber.min(0),
    y: finiteNumber.min(0)
  })
  .strict();

export const InpaintingExportRequestSchema = z.object({ chapterId: uuid }).strict();

export const RenameWorkRequestSchema = z.object({ workId: uuid, title }).strict();
export const RenameChapterRequestSchema = z.object({ chapterId: uuid, title }).strict();
export const DeleteWorkRequestSchema = z.object({ workId: uuid }).strict();
export const DeleteChapterRequestSchema = z.object({ chapterId: uuid }).strict();
export const OpenChapterRequestSchema = z.object({ chapterId: uuid }).strict();
export const ImageDataUrlRequestSchema = z.object({ imagePath: filePath }).strict();
export const ReorderChaptersRequestSchema = z.object({ workId: uuid, chapterIds: z.array(uuid).max(MAX_ID_LIST_LENGTH) }).strict();
export const ReorderPagesRequestSchema = z.object({ chapterId: uuid, pageIds: z.array(uuid).max(MAX_ID_LIST_LENGTH) }).strict();
export const DeletePageRequestSchema = z.object({ chapterId: uuid, pageId: uuid }).strict();

export const AppSettingsSchema = z
  .object({
    modelProvider: z.enum(["gemma", "openai-codex"]),
    gemma: z
      .object({
        modelSource: z.enum(["huggingface", "local"]),
        modelRepo: z.string().min(1).max(300),
        modelFile: z.string().min(1).max(300),
        mmprojRepo: z.string().min(1).max(300).optional(),
        mmprojFile: z.string().min(1).max(300).optional(),
        localModelPath: filePath.optional(),
        localMmprojPath: filePath.optional(),
        vramMode: z.enum(["full", "economy"])
      })
      .strict(),
    codex: z
      .object({
        model: z.string().min(1).max(120),
        reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]),
        oauthPort: z.number().int().min(1).max(65535)
      })
      .strict(),
    ocr: z.object({
      device: z.enum(["cpu", "gpu"]),
      gpuCudaTag: z.string().regex(/^cu\d+$/i).optional()
    }).strict(),
    maxTokens: z.number().int().min(1024).max(64000)
  })
  .strict();

export const RendererLogRequestSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string().min(1).max(1000),
    detail: z.unknown().optional()
  })
  .strict();

export function parseIpcPayload<T>(schema: z.ZodType<T>, payload: unknown, label: string): T {
  const result = schema.safeParse(payload);
  if (result.success) {
    return result.data;
  }

  const firstIssue = result.error.issues[0];
  const path = firstIssue?.path.length ? firstIssue.path.join(".") : "payload";
  const message = firstIssue ? `${path}: ${firstIssue.message}` : "unknown validation error";
  throw new Error(`${label} 요청 형식이 올바르지 않습니다. ${message}`);
}
