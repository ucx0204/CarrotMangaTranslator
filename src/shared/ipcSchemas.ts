import { z } from "zod";
import { coerceOpenAiCompatibleBaseUrl } from "./apiSettings";
import {
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
} from "./modelPresets";
import {
  JobKindSchema,
  JobPhaseSchema,
  JobStatusSchema,
  ProgressModeSchema,
} from "./jobContracts";

const MAX_TITLE_LENGTH = 240;
const MAX_TEXT_LENGTH = 20000;
const MAX_PATH_LENGTH = 4096;
const MAX_ID_LIST_LENGTH = 2000;
const MAX_PAGES_PER_REQUEST = 2000;
const MAX_BLOCKS_PER_PAGE = 500;
const MAX_MASK_STROKES = 200;
const MAX_STROKE_POINTS = 1200;
const MAX_RETAINED_INPAINTING_ARTIFACTS = 200;
const MAX_GATHERED_TEXT_LENGTH = 5_000_000;
const MAX_GLOSSARY_ENTRIES = 1000;
const MAX_CHARACTER_PROFILES = 300;
const MAX_STORY_MEMORY_PAGES = 2000;

const finiteNumber = z.number().finite();
const uuid = z.string().uuid();
const storeId = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\"),
    "invalid store id",
  );
const title = z.string().max(MAX_TITLE_LENGTH);
const filePath = z.string().min(1).max(MAX_PATH_LENGTH);
const boundedText = z.string().max(MAX_TEXT_LENGTH);
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i);
const ReviewStatusSchema = z.enum(["draft", "needs_review", "reviewed"]);
const LegacyRenderDirectionSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (normalized === "vertical") {
      return "vertical";
    }
    if (
      normalized === "horizontal" ||
      normalized === "rotated" ||
      normalized === "hidden"
    ) {
      return "horizontal";
    }
    return value;
  },
  z.enum(["horizontal", "vertical"]),
);
const GemmaVramModeSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (
      ["minimum12b", "minimum", "minimal", "min", "12b"].includes(normalized)
    ) {
      return "minimum12b";
    }
    if (["economy26b", "economy", "eco", "26b"].includes(normalized)) {
      return "economy26b";
    }
    if (["full31b", "full", "31b"].includes(normalized)) {
      return "full31b";
    }
    return value;
  },
  z.enum(["minimum12b", "economy26b", "full31b"]),
);
const LlamaRuntimeProfileSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (
      ["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"].includes(
        normalized,
      )
    ) {
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
  },
  z.enum(["cuda12", "rtx50", "rocm", "vulkan"]),
);
const AmdRocmTargetSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[-_\s]/g, "");
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
  },
  z.enum([
    "gfx908",
    "gfx90a",
    "gfx103X",
    "gfx110X",
    "gfx1150",
    "gfx1151",
    "gfx120X",
  ]),
);
const FluxBackendSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (["auto", ""].includes(normalized)) {
      return "cuda-native";
    }
    if (["cuda-native", "cuda", "native", "nvidia"].includes(normalized)) {
      return "cuda-native";
    }
    if (["zluda-native", "zluda"].includes(normalized)) {
      return "zluda-native";
    }
    if (["python-rocm", "rocm", "hip", "amd"].includes(normalized)) {
      return "zluda-native";
    }
    if (["python-cpu", "cpu"].includes(normalized)) {
      return "python-cpu";
    }
    if (["candle-cpu", "candle", "koharu"].includes(normalized)) {
      return "zluda-native";
    }
    return value;
  },
  z.enum(["cuda-native", "zluda-native", "python-cpu"]),
);

const OcrGpuBackendSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (["auto", "", "cuda", "nvidia"].includes(normalized)) {
      return "cuda";
    }
    if (
      ["rocm", "amd", "hip", "rocm-transformers", "transformers-rocm"].includes(
        normalized,
      )
    ) {
      return "rocm-transformers";
    }
    return value;
  },
  z.enum(["cuda", "rocm-transformers"]),
);

const OpenAiCompatibleBaseUrlSchema = z.preprocess(
  (value) => coerceOpenAiCompatibleBaseUrl(value) ?? value,
  z
    .string()
    .min(1)
    .max(1000)
    .refine(
      (value) => coerceOpenAiCompatibleBaseUrl(value) !== null,
      "invalid API base URL",
    ),
);
const ApiReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const JsonObjectStringSchema = z
  .string()
  .max(MAX_TEXT_LENGTH)
  .refine((value) => !value.trim() || isJsonObjectString(value), {
    message: "must be a JSON object string",
  });
const CustomHeadersJsonObjectStringSchema = z
  .string()
  .max(MAX_TEXT_LENGTH)
  .refine((value) => !value.trim() || isValidCustomHeadersJson(value), {
    message:
      "must be a JSON object with string, number, or boolean header values",
  });

export const BBoxSchema = z
  .object({
    x: finiteNumber.min(0).max(1000),
    y: finiteNumber.min(0).max(1000),
    w: finiteNumber.min(0).max(1000),
    h: finiteNumber.min(0).max(1000),
  })
  .strict()
  .transform((bbox) => clampNormalizedBbox(bbox));

export const TranslationBlockSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.preprocess(() => "nonsolid", z.literal("nonsolid")),
    bbox: BBoxSchema,
    renderBbox: BBoxSchema.optional(),
    bboxSpace: z.enum(["normalized_1000", "pixels"]).optional(),
    renderBboxSpace: z.enum(["normalized_1000", "pixels"]).optional(),
    sourceText: boundedText,
    translatedText: boundedText,
    confidence: finiteNumber.min(0).max(1),
    sourceDirection: z.enum(["horizontal", "vertical"]),
    renderDirection: LegacyRenderDirectionSchema,
    rotationDeg: finiteNumber.min(-30).max(30).optional(),
    fontFamily: z.string().max(120).optional(),
    fontSizePx: finiteNumber.min(1).max(512),
    lineHeight: finiteNumber.min(0.5).max(4),
    letterSpacing: finiteNumber.min(-0.5).max(2).optional(),
    textAlign: z.enum(["left", "center", "right"]),
    textColor: hexColor,
    outlineColor: hexColor.optional(),
    outlineWidthScale: finiteNumber.min(0).max(8).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    backgroundColor: hexColor,
    opacity: finiteNumber.min(0).max(1),
    autoFitText: z.boolean().optional(),
    inpaintExcluded: z.boolean().optional(),
    reviewStatus: ReviewStatusSchema.optional(),
    reviewNote: z.string().max(4000).optional(),
    speakerId: z.string().max(200).optional(),
    glossaryEntryIds: z.array(z.string().max(200)).max(50).optional(),
  })
  .strict();

const GlossaryEntryCategorySchema = z.enum([
  "character",
  "alias",
  "place",
  "term",
  "sfx",
  "honorific",
  "other",
]);

const CharacterSpeechStyleSchema = z.enum([
  "neutral",
  "polite",
  "casual",
  "rough",
  "childish",
  "elderly",
  "formal",
  "custom",
]);

const DefaultToneSchema = z.preprocess(
  (value) => {
    if (value === "webtoon" || value === "formal") {
      return "natural_korean";
    }
    return value;
  },
  z.enum(["natural_korean", "literal"]),
);

export const WorkStyleGuideSchema = z
  .object({
    schemaVersion: z.literal(1),
    workId: storeId,
    glossary: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            source: z.string().min(1).max(400),
            target: z.string().max(400),
            category: GlossaryEntryCategorySchema,
            aliases: z.array(z.string().max(200)).max(50).optional(),
            note: z.string().max(2000).optional(),
            enabled: z.boolean(),
            createdAt: z.string().max(80),
            updatedAt: z.string().max(80),
          })
          .strict(),
      )
      .max(MAX_GLOSSARY_ENTRIES),
    characters: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            displayName: z.string().min(1).max(200),
            sourceNames: z.array(z.string().min(1).max(200)).max(50),
            targetName: z.string().max(200),
            aliases: z.array(z.string().max(200)).max(50).optional(),
            speechStyle: CharacterSpeechStyleSchema,
            customSpeechStyle: z.string().max(1000).optional(),
            note: z.string().max(2000).optional(),
            enabled: z.boolean(),
            createdAt: z.string().max(80),
            updatedAt: z.string().max(80),
          })
          .strict(),
      )
      .max(MAX_CHARACTER_PROFILES),
    rules: z
      .object({
        honorifics: z.enum(["preserve", "adapt", "drop"]),
        sfxMode: z.enum(["preserve", "translate", "note"]),
        defaultTone: DefaultToneSchema,
      })
      .strict(),
    createdAt: z.string().max(80),
    updatedAt: z.string().max(80),
  })
  .strict();

export const ChapterStoryMemorySchema = z
  .object({
    schemaVersion: z.literal(1),
    workId: storeId,
    chapterId: storeId,
    pages: z
      .array(
        z
          .object({
            pageId: storeId,
            pageName: z.string().max(260),
            pageIndex: z.number().int().min(0).max(MAX_PAGES_PER_REQUEST),
            sourceDigest: z.string().max(2000),
            translatedDigest: z.string().max(2000),
            summary: z.string().max(1200),
            characterIds: z.array(z.string().max(200)).max(100).optional(),
            updatedAt: z.string().max(80),
          })
          .strict(),
      )
      .max(MAX_STORY_MEMORY_PAGES),
    updatedAt: z.string().max(80),
    aiAnalyzedAt: z.string().max(80).optional(),
  })
  .strict();

const PageAnalysisStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "failed",
]);
const ChapterStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "partial",
  "failed",
]);
const ImportSourceKindSchema = z.enum([
  "images",
  "folder",
  "zip",
  "zip-folder",
]);
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
    updatedAt: z.string().max(80),
  })
  .strict();

export const LibraryPageRecordSchema = z
  .object({
    id: storeId,
    name: z.string().min(1).max(260),
    imagePath: filePath,
    inpaintedImagePath: filePath.optional(),
    width: z.number().int().min(1).max(100000),
    height: z.number().int().min(1).max(100000),
    blocks: z.array(TranslationBlockSchema).max(MAX_BLOCKS_PER_PAGE),
    analysisStatus: PageAnalysisStatusSchema,
    lastError: z.string().max(4000).optional(),
    createdAt: z.string().max(80),
    updatedAt: z.string().max(80),
  })
  .strict();

export const LibraryChapterFileSchema = z
  .object({
    id: storeId,
    workId: storeId,
    title,
    sourceKind: ImportSourceKindSchema,
    status: ChapterStatusSchema,
    pageOrder: z.array(storeId).max(MAX_PAGES_PER_REQUEST),
    pages: z.array(LibraryPageRecordSchema).max(MAX_PAGES_PER_REQUEST),
    createdAt: z.string().max(80),
    updatedAt: z.string().max(80),
  })
  .strict();

export const LibraryWorkFileSchema = z
  .object({
    id: storeId,
    title,
    chapterOrder: z.array(storeId).max(MAX_ID_LIST_LENGTH),
    createdAt: z.string().max(80),
    updatedAt: z.string().max(80),
  })
  .strict();

export const StoredLibraryIndexFileSchema = z
  .object({
    workOrder: z.array(storeId).max(MAX_ID_LIST_LENGTH),
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
    updatedAt: z.string().max(80),
  })
  .strict();

export const CreateImportRequestSchema = z
  .object({
    previewId: uuid,
    target: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("new"), title }).strict(),
      z.object({ mode: z.literal("existing"), workId: uuid }).strict(),
    ]),
    selections: z
      .array(
        z
          .object({
            draftId: uuid,
            title,
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export const WorkShareExportRequestSchema = z
  .object({
    workId: uuid,
    chapterIds: z.array(uuid).min(1).max(MAX_ID_LIST_LENGTH),
  })
  .strict();

export const SaveTextFileRequestSchema = z
  .object({
    defaultName: z.string().min(1).max(260),
    content: z.string().max(MAX_GATHERED_TEXT_LENGTH),
  })
  .strict();

export const WorkStyleGuideRequestSchema = z.object({ workId: uuid }).strict();

export const ChapterStoryMemoryRequestSchema = z
  .object({ chapterId: uuid })
  .strict();

export const AnalyzeWorkContextRequestSchema = z
  .object({
    chapterId: uuid,
    scope: z.enum(["chapter", "work", "missing"]).optional(),
    maxInputChars: z.number().int().min(4000).max(500000).optional(),
  })
  .strict();

export const ExportReviewTextRequestSchema = z
  .object({
    chapterId: uuid,
    format: z.enum(["csv", "tsv"]),
    includeBom: z.boolean().optional(),
  })
  .strict();

export const ImportReviewTextRequestSchema = z
  .object({
    chapterId: uuid,
    content: z.string().max(MAX_GATHERED_TEXT_LENGTH),
    format: z.enum(["csv", "tsv", "auto"]),
    updateSourceText: z.boolean().optional(),
    requireSourceMatch: z.boolean().optional(),
  })
  .strict();

export const WorkShareImportRequestSchema = z
  .object({
    previewId: uuid,
    target: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("new"), title }).strict(),
      z.object({ mode: z.literal("existing"), workId: uuid }).strict(),
    ]),
    entries: z
      .array(
        z.discriminatedUnion("source", [
          z
            .object({ source: z.literal("existing"), chapterId: uuid, title })
            .strict(),
          z
            .object({
              source: z.literal("package"),
              packageChapterId: z.string().min(1).max(200),
              title,
            })
            .strict(),
        ]),
      )
      .max(MAX_ID_LIST_LENGTH),
  })
  .strict();

export const StartAnalysisRequestSchema = z.discriminatedUnion("runMode", [
  z.object({ chapterId: uuid, runMode: z.literal("pending") }).strict(),
  z.object({ chapterId: uuid, runMode: z.literal("all") }).strict(),
  z
    .object({
      chapterId: uuid,
      runMode: z.literal("single-page"),
      pageId: uuid,
    })
    .strict(),
]);

export const RegionAnalysisRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    bbox: BBoxSchema,
  })
  .strict();

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

export const RenameWorkRequestSchema = z
  .object({ workId: uuid, title })
  .strict();
export const RenameChapterRequestSchema = z
  .object({ chapterId: uuid, title })
  .strict();
export const DeleteWorkRequestSchema = z.object({ workId: uuid }).strict();
export const DeleteChapterRequestSchema = z
  .object({ chapterId: uuid })
  .strict();
export const OpenChapterRequestSchema = z.object({ chapterId: uuid }).strict();
export const ImageDataUrlRequestSchema = z
  .object({ imagePath: filePath })
  .strict();
export const SavePageBlocksRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    baseUpdatedAt: z.string().max(80).optional(),
    baseBlocksHash: z.string().min(1).max(80).optional(),
    blocks: z.array(TranslationBlockSchema).max(MAX_BLOCKS_PER_PAGE),
  })
  .strict();
export const ReorderChaptersRequestSchema = z
  .object({ workId: uuid, chapterIds: z.array(uuid).max(MAX_ID_LIST_LENGTH) })
  .strict();
export const ReorderPagesRequestSchema = z
  .object({ chapterId: uuid, pageIds: z.array(uuid).max(MAX_ID_LIST_LENGTH) })
  .strict();
export const DeletePageRequestSchema = z
  .object({ chapterId: uuid, pageId: uuid })
  .strict();

export const AppSettingsSchema = z
  .object({
    modelProvider: z.enum(["gemma", "openai-codex", "openai-api"]),
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
        llamaRocmTarget: AmdRocmTargetSchema.optional(),
      })
      .strict(),
    codex: z
      .object({
        model: z.string().min(1).max(120),
        reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]),
        oauthPort: z.number().int().min(1).max(65535),
      })
      .strict(),
    api: z
      .object({
        baseUrl: OpenAiCompatibleBaseUrlSchema,
        model: z.string().min(1).max(200),
        apiKey: z.string().max(4000).optional(),
        temperature: z.number().min(0).max(2).nullable().optional(),
        topP: z.number().min(0).max(1).nullable().optional(),
        topK: z.number().int().min(1).max(1000).nullable().optional(),
        reasoningEffort: ApiReasoningEffortSchema.nullable().optional(),
        extraBodyJson: JsonObjectStringSchema.optional(),
        customHeadersJson: CustomHeadersJsonObjectStringSchema.optional(),
      })
      .strict(),
    ocr: z
      .object({
        device: z.enum(["cpu", "gpu"]),
        gpuCudaTag: z
          .string()
          .regex(/^cu\d+$/i)
          .optional(),
        gpuBackend: OcrGpuBackendSchema.optional(),
      })
      .strict(),
    ui: z
      .object({
        inpaintingGuideHidden: z.boolean().optional(),
        twoPassByDefault: z.boolean().optional(),
        analysisScopeDefault: z.enum(["work", "missing", "chapter"]).optional(),
      })
      .strict()
      .optional(),
    inpainting: z
      .object({
        fluxBackend: FluxBackendSchema.optional(),
      })
      .strict()
      .optional(),
    runtimeHardware: z
      .object({
        gpuVendor: z.enum(["nvidia", "amd", "unknown"]),
        gpuName: z.string().max(300).nullable().optional(),
        llamaRocmTarget: AmdRocmTargetSchema.nullable().optional(),
        supportsRocm: z.boolean().optional(),
        supportsVulkan: z.boolean().optional(),
      })
      .strict()
      .optional(),
    maxTokens: z.number().int().min(MIN_MAX_TOKENS).max(MAX_MAX_TOKENS),
    ctx: z.number().int().min(MIN_CONTEXT_TOKENS),
  })
  .strict();

export const RendererLogRequestSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string().min(1).max(1000),
    detail: z.unknown().optional(),
  })
  .strict();

export function parseIpcPayload<TSchema extends z.ZodType>(
  schema: TSchema,
  payload: unknown,
  label: string,
): z.output<TSchema> {
  const result = schema.safeParse(payload);
  if (result.success) {
    return result.data;
  }

  const firstIssue = result.error.issues[0];
  const path = firstIssue?.path.length ? firstIssue.path.join(".") : "payload";
  const message = firstIssue
    ? `${path}: ${firstIssue.message}`
    : "unknown validation error";
  throw new Error(`${label} 요청 형식이 올바르지 않습니다. ${message}`);
}

function isJsonObjectString(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return Boolean(
      parsed && typeof parsed === "object" && !Array.isArray(parsed),
    );
  } catch (_error) {
    return false;
  }
}

function isValidCustomHeadersJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return Object.entries(parsed).every(([key, headerValue]) => {
      if (isForbiddenCustomHeader(key)) {
        return false;
      }
      return (
        typeof headerValue === "string" ||
        typeof headerValue === "number" ||
        typeof headerValue === "boolean"
      );
    });
  } catch (_error) {
    return false;
  }
}

function isForbiddenCustomHeader(name: string): boolean {
  return [
    "authorization",
    "content-type",
    "host",
    "content-length",
    "cookie",
    "set-cookie",
  ].includes(name.trim().toLowerCase());
}

function clampNormalizedBbox(bbox: {
  x: number;
  y: number;
  w: number;
  h: number;
}): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const x = Math.min(999, Math.max(0, bbox.x));
  const y = Math.min(999, Math.max(0, bbox.y));
  const w = Math.min(1000 - x, Math.max(1, bbox.w));
  const h = Math.min(1000 - y, Math.max(1, bbox.h));
  return { x, y, w, h };
}
