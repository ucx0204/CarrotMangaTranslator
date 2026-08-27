import { z } from "zod";
import {
  MAX_BLOCKS_PER_PAGE,
  MAX_ID_LIST_LENGTH,
  MAX_IMAGE_DIMENSION,
  MAX_PAGES_PER_REQUEST,
  TranslationBlockSchema,
  filePath,
  storeId,
  title,
  uuid,
} from "./ipcSchemaPrimitives";
import { LinkedWorkspaceImportOptionsSchema } from "./linkedWorkspaceSchemas";

const PageAnalysisStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "failed",
]);
const TranslationCompletionReceiptSchema = z
  .object({
    workflow: z.enum(["erase-original", "bubble-layout"]),
    status: z.enum(["pending", "completed", "failed"]),
    erasedBlockIds: z
      .array(z.string().min(1).max(200))
      .max(MAX_BLOCKS_PER_PAGE)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  })
  .strict();
const PageProcessingTimingStagesSchema = z
  .object({
    preparing: z.number().int().min(0).max(604_800_000).optional(),
    ocr: z.number().int().min(0).max(604_800_000).optional(),
    translation: z.number().int().min(0).max(604_800_000).optional(),
    postprocessing: z.number().int().min(0).max(604_800_000).optional(),
    typography: z.number().int().min(0).max(604_800_000).optional(),
    inpainting: z.number().int().min(0).max(604_800_000).optional(),
    bubbleLayout: z.number().int().min(0).max(604_800_000).optional(),
  })
  .strict();
const PageProcessingTimingSchema = z
  .object({
    version: z.literal(1),
    stages: PageProcessingTimingStagesSchema,
    measuredAt: z.string().datetime(),
    translationJobId: z.string().min(1).max(200).optional(),
    inpaintingJobId: z.string().min(1).max(200).optional(),
  })
  .strict();
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

const PageRecordPathShape = {
  name: z.string().min(1).max(260),
  imagePath: filePath,
  inpaintedImagePath: filePath.optional(),
  sourceFileName: z.string().min(1).max(260).optional(),
  sourceRelativePath: z.string().min(1).max(4096).optional(),
  inpaintMaskPath: filePath.optional(),
  maskProvenance: z
    .enum(["actual-mask", "retouch-updated", "derived-diff"])
    .optional(),
};

const PageRecordContentShape = {
  width: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
  height: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
  blocks: z.array(TranslationBlockSchema).max(MAX_BLOCKS_PER_PAGE),
  blockOrder: z
    .array(z.string().min(1).max(200))
    .max(MAX_BLOCKS_PER_PAGE)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
  analysisStatus: PageAnalysisStatusSchema,
  translationCompletion: TranslationCompletionReceiptSchema.optional(),
  processingTiming: PageProcessingTimingSchema.optional(),
  lastError: z.string().max(4000).optional(),
  createdAt: z.string().max(80),
  updatedAt: z.string().max(80),
};

const MangaPageSchema = z
  .object({
    id: uuid,
    ...PageRecordPathShape,
    dataUrl: z.string().max(32 * 1024 * 1024),
    ...PageRecordContentShape,
  })
  .strict();

const LibraryPageRecordSchema = z
  .object({
    id: storeId,
    ...PageRecordPathShape,
    ...PageRecordContentShape,
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
    readingDirection: z.enum(["auto", "rtl", "ltr"]).optional(),
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

const LibraryChapterSummarySchema = z
  .object({
    id: storeId,
    workId: storeId,
    title,
    status: ChapterStatusSchema,
    createdAt: z.string().max(80),
    updatedAt: z.string().max(80),
    pageCount: z.number().int().min(0).max(MAX_PAGES_PER_REQUEST),
  })
  .strict();

const LibraryWorkSummarySchema = z
  .object({
    id: storeId,
    title,
    chapterOrder: z.array(storeId).max(MAX_ID_LIST_LENGTH),
    readingDirection: z.enum(["auto", "rtl", "ltr"]).optional(),
    createdAt: z.string().max(80),
    updatedAt: z.string().max(80),
    chapters: z.array(LibraryChapterSummarySchema).max(MAX_ID_LIST_LENGTH),
  })
  .strict();

export const LibraryIndexSchema = z
  .object({
    workOrder: z.array(storeId).max(MAX_ID_LIST_LENGTH),
    works: z.array(LibraryWorkSummarySchema).max(MAX_ID_LIST_LENGTH),
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
    linkedWorkspace: LinkedWorkspaceImportOptionsSchema.optional(),
  })
  .strict();

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
const SavePageBlocksUpdateSchema = z
  .object({
    pageId: uuid,
    baseUpdatedAt: z.string().max(80).optional(),
    baseBlocksHash: z.string().min(1).max(80).optional(),
    blocks: z.array(TranslationBlockSchema).max(MAX_BLOCKS_PER_PAGE),
    blockOrder: z
      .array(z.string().min(1).max(200))
      .max(MAX_BLOCKS_PER_PAGE)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  })
  .strict();
export const SavePageBlocksRequestSchema = SavePageBlocksUpdateSchema.extend({
  chapterId: uuid,
  dirtyVersion: z.number().int().nonnegative().optional(),
  saveReason: z.enum(["autosave", "manual"]).optional(),
}).strict();
export const SavePagesBlocksRequestSchema = z
  .object({
    chapterId: uuid,
    pages: z
      .array(SavePageBlocksUpdateSchema)
      .min(1)
      .max(MAX_PAGES_PER_REQUEST),
    dirtyVersion: z.number().int().nonnegative().optional(),
    saveReason: z.enum(["autosave", "manual"]).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const pageIds = new Set<string>();
    request.pages.forEach((page, index) => {
      if (pageIds.has(page.pageId)) {
        context.addIssue({
          code: "custom",
          message: "중복된 페이지 저장 요청입니다.",
          path: ["pages", index, "pageId"],
        });
      }
      pageIds.add(page.pageId);
    });
  });
export const ReorderChaptersRequestSchema = z
  .object({ workId: uuid, chapterIds: z.array(uuid).max(MAX_ID_LIST_LENGTH) })
  .strict();
export const ReorderPagesRequestSchema = z
  .object({ chapterId: uuid, pageIds: z.array(uuid).max(MAX_ID_LIST_LENGTH) })
  .strict();
export const DeletePageRequestSchema = z
  .object({ chapterId: uuid, pageId: uuid })
  .strict();
