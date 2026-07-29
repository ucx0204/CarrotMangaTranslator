import { z } from "zod";

export {
  BubbleLayoutSchema,
  TranslationBlockSchema,
} from "./ipcSchemaPrimitives";
export {
  AnalyzeWorkContextRequestSchema,
  ChapterStoryMemoryRequestSchema,
  ChapterStoryMemorySchema,
  ExportReviewTextRequestSchema,
  ImportReviewTextRequestSchema,
  SaveTextFileRequestSchema,
  WorkShareExportRequestSchema,
  WorkShareImportRequestSchema,
  WorkStyleGuideRequestSchema,
  WorkStyleGuideSchema,
} from "./ipcWorkContextSchemas";
export {
  ChapterSnapshotSchema,
  CreateImportRequestSchema,
  DeleteChapterRequestSchema,
  DeletePageRequestSchema,
  DeleteWorkRequestSchema,
  ImageDataUrlRequestSchema,
  LibraryChapterFileSchema,
  LibraryIndexSchema,
  LibraryWorkFileSchema,
  OpenChapterRequestSchema,
  RenameChapterRequestSchema,
  RenameWorkRequestSchema,
  ReorderChaptersRequestSchema,
  ReorderPagesRequestSchema,
  SavePageBlocksRequestSchema,
  SavePagesBlocksRequestSchema,
  StoredLibraryIndexFileSchema,
} from "./ipcLibrarySchemas";
export {
  ApplyInpaintingHistoryTransactionRequestSchema,
  InpaintingColorSampleRequestSchema,
  InpaintingRetouchRequestSchema,
  InpaintingRevertRequestSchema,
  JobEventSchema,
  ModelTestProgressEventSchema,
  PageImageExportRequestSchema,
  RegionAnalysisRequestSchema,
  ReleaseInpaintingHistoryTransactionsRequestSchema,
  RendererLogRequestSchema,
  SetPageInpaintingResultRequestSchema,
  StartAnalysisRequestSchema,
  StartInpaintingRequestSchema,
} from "./ipcJobSchemas";
export { AppSettingsSchema } from "./ipcSettingsSchemas";

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
