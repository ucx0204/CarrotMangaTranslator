import { z } from "zod";
import {
  MAX_BLOCKS_PER_PAGE,
  MAX_ID_LIST_LENGTH,
  MAX_PAGES_PER_REQUEST,
  TranslationBlockSchema,
  filePath,
  storeId,
  title,
  uuid,
} from "./ipcSchemaPrimitives";

export const PageAnalysisStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "failed",
]);
export const ChapterStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "partial",
  "failed",
]);
export const ImportSourceKindSchema = z.enum([
  "images",
  "folder",
  "zip",
  "zip-folder",
]);

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

export const LibraryChapterSummarySchema = z
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

export const LibraryWorkSummarySchema = z
  .object({
    id: storeId,
    title,
    chapterOrder: z.array(storeId).max(MAX_ID_LIST_LENGTH),
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
export const SavePageBlocksRequestSchema = z
  .object({
    chapterId: uuid,
    pageId: uuid,
    baseUpdatedAt: z.string().max(80).optional(),
    baseBlocksHash: z.string().min(1).max(80).optional(),
    dirtyVersion: z.number().int().nonnegative().optional(),
    saveReason: z.enum(["autosave", "manual"]).optional(),
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
