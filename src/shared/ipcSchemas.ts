import { z } from "zod";

const MAX_TITLE_LENGTH = 240;
const MAX_TEXT_LENGTH = 20000;
const MAX_PATH_LENGTH = 4096;
const MAX_ID_LIST_LENGTH = 2000;
const MAX_PAGES_PER_REQUEST = 2000;
const MAX_BLOCKS_PER_PAGE = 500;
const MAX_MASK_STROKES = 200;
const MAX_STROKE_POINTS = 1200;
const MAX_RETAINED_INPAINTING_ARTIFACTS = 200;

const finiteNumber = z.number().finite();
const uuid = z.string().uuid();
const title = z.string().max(MAX_TITLE_LENGTH);
const filePath = z.string().min(1).max(MAX_PATH_LENGTH);
const boundedText = z.string().max(MAX_TEXT_LENGTH);
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i);
const RenderDirectionSchema = z
  .custom<"horizontal" | "vertical" | "rotated" | "hidden">((value) =>
    ["horizontal", "vertical", "rotated", "hidden"].includes(String(value ?? "").trim().toLowerCase())
  )
  .transform((value): "horizontal" | "vertical" => (value === "vertical" ? "vertical" : "horizontal"));
const GemmaVramModeSchema = z.preprocess((value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["minimum12b", "minimum", "minimal", "min", "12b"].includes(normalized)) {
    return "minimum12b";
  }
  if (["economy26b", "economy", "eco", "26b"].includes(normalized)) {
    return "economy26b";
  }
  if (["full31b", "full", "31b"].includes(normalized)) {
    return "full31b";
  }
  return value;
}, z.enum(["minimum12b", "economy26b", "full31b"]));
const LlamaRuntimeProfileSchema = z.preprocess((value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"].includes(normalized)) {
    return "rtx50";
  }
  if (["cuda12", "cuda12.4", "cuda"].includes(normalized)) {
    return "cuda12";
  }
  if (["rocm", "hip", "amd-rocm"].includes(normalized)) {
    return "rocm";
  }
  if (["vulkan", "amd-vulkan", "vk"].includes(normalized)) {
    return "vulkan";
  }
  return value;
}, z.enum(["cuda12", "rtx50", "rocm", "vulkan"]));
const AmdRocmTargetSchema = z.preprocess((value) => {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[-_\s]/g, "");
  if (normalized === "gfx908") {
    return "gfx908";
  }
  if (normalized === "gfx90a") {
    return "gfx90a";
  }
  if (/^gfx103[0-9a-fx]*$/.test(normalized)) {
    return "gfx103X";
  }
  if (/^gfx110[0-9a-fx]*$/.test(normalized)) {
    return "gfx110X";
  }
  if (normalized === "gfx1150") {
    return "gfx1150";
  }
  if (normalized === "gfx1151") {
    return "gfx1151";
  }
  if (/^gfx120[0-9a-fx]*$/.test(normalized)) {
    return "gfx120X";
  }
  return value;
}, z.enum(["gfx908", "gfx90a", "gfx103X", "gfx110X", "gfx1150", "gfx1151", "gfx120X"]));
const FluxBackendSchema = z.preprocess((value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["auto", ""].includes(normalized)) {
    return "cuda-native";
  }
  if (["cuda-native", "cuda", "native", "nvidia"].includes(normalized)) {
    return "cuda-native";
  }
  if (["python-rocm", "rocm", "hip", "amd"].includes(normalized)) {
    return "python-rocm";
  }
  if (["python-cpu", "cpu"].includes(normalized)) {
    return "python-cpu";
  }
  return value;
}, z.enum(["cuda-native", "python-rocm", "python-cpu"]));

const OcrGpuBackendSchema = z.preprocess((value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["rocm", "hip", "amd"].includes(normalized)) {
    return "rocm";
  }
  if (["auto", "", "cuda", "nvidia"].includes(normalized)) {
    return "cuda";
  }
  return value;
}, z.enum(["cuda", "rocm"]));

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
    renderDirection: RenderDirectionSchema,
    rotationDeg: finiteNumber.min(-30).max(30).optional(),
    fontFamily: z.string().max(120).optional(),
    fontSizePx: finiteNumber.min(1).max(512),
    lineHeight: finiteNumber.min(0.5).max(4),
    textAlign: z.enum(["left", "center", "right"]),
    textColor: hexColor,
    outlineColor: hexColor.optional(),
    outlineWidthScale: finiteNumber.min(0).max(8).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    backgroundColor: hexColor,
    opacity: finiteNumber.min(0).max(1),
    autoFitText: z.boolean().optional(),
    inpaintExcluded: z.boolean().optional()
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

export const StartAnalysisRequestSchema = z.discriminatedUnion("runMode", [
  z.object({ chapterId: uuid, runMode: z.literal("pending") }).strict(),
  z.object({ chapterId: uuid, runMode: z.literal("all") }).strict(),
  z.object({ chapterId: uuid, runMode: z.literal("single-page"), pageId: uuid }).strict()
]);

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
  z.object({ chapterId: uuid, mode: z.literal("chapter-pattern-pending") }).strict(),
  z.object({ chapterId: uuid, mode: z.literal("page-pattern"), pageId: uuid }).strict(),
  z
    .object({
      chapterId: uuid,
      mode: z.literal("page-pattern-drawn"),
      pageId: uuid,
      strokes: z.array(InpaintingMaskStrokeSchema).min(1).max(MAX_MASK_STROKES),
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
    color: hexColor.optional(),
    retainedInpaintedArtifactPaths: z.array(filePath).max(MAX_RETAINED_INPAINTING_ARTIFACTS).optional()
  })
  .strict();

export const SetPageInpaintingResultRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    inpaintedImagePath: filePath.nullable().optional(),
    retainedInpaintedArtifactPaths: z.array(filePath).max(MAX_RETAINED_INPAINTING_ARTIFACTS).optional()
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

export const InpaintingExportRequestSchema = z.discriminatedUnion("scope", [
  z.object({ chapterId: uuid, scope: z.literal("chapter") }).strict(),
  z.object({ chapterId: uuid, scope: z.literal("page"), pageId: uuid }).strict()
]);

export const RenameWorkRequestSchema = z.object({ workId: uuid, title }).strict();
export const RenameChapterRequestSchema = z.object({ chapterId: uuid, title }).strict();
export const DeleteWorkRequestSchema = z.object({ workId: uuid }).strict();
export const DeleteChapterRequestSchema = z.object({ chapterId: uuid }).strict();
export const OpenChapterRequestSchema = z.object({ chapterId: uuid }).strict();
export const ImageDataUrlRequestSchema = z.object({ imagePath: filePath }).strict();
export const SavePageBlocksRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    baseUpdatedAt: z.string().max(80).optional(),
    blocks: z.array(TranslationBlockSchema).max(MAX_BLOCKS_PER_PAGE)
  })
  .strict();
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
        vramMode: GemmaVramModeSchema,
        llamaRuntimeProfile: LlamaRuntimeProfileSchema.optional(),
        llamaRocmTarget: AmdRocmTargetSchema.optional()
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
      gpuCudaTag: z.string().regex(/^cu\d+$/i).optional(),
      gpuBackend: OcrGpuBackendSchema.optional()
    }).strict(),
    ui: z.object({
      inpaintingGuideHidden: z.boolean().optional()
    }).strict().optional(),
    inpainting: z.object({
      fluxBackend: FluxBackendSchema.optional()
    }).strict().optional(),
    runtimeHardware: z.object({
      gpuVendor: z.enum(["nvidia", "amd", "unknown"]),
      gpuName: z.string().max(300).nullable().optional(),
      llamaRocmTarget: AmdRocmTargetSchema.nullable().optional(),
      supportsRocm: z.boolean().optional(),
      supportsVulkan: z.boolean().optional()
    }).strict().optional(),
    maxTokens: z.number().int().min(300).max(12000)
  })
  .strict();

export const RendererLogRequestSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string().min(1).max(1000),
    detail: z.unknown().optional()
  })
  .strict();

export function parseIpcPayload<TSchema extends z.ZodType>(schema: TSchema, payload: unknown, label: string): z.output<TSchema> {
  const result = schema.safeParse(payload);
  if (result.success) {
    return result.data;
  }

  const firstIssue = result.error.issues[0];
  const path = firstIssue?.path.length ? firstIssue.path.join(".") : "payload";
  const message = firstIssue ? `${path}: ${firstIssue.message}` : "unknown validation error";
  throw new Error(`${label} 요청 형식이 올바르지 않습니다. ${message}`);
}
