import { z } from "zod";
import type {
  CreateImportRequest,
  CreateImportResult,
  DroppedImportPreviewResponse,
  ImportPreviewSession,
} from "./importTypes";
import type { ChapterSnapshot, LibraryIndex } from "./libraryTypes";
import type {
  PrepareSoundEffectTranslationRequest,
  PrepareSoundEffectTranslationResult,
} from "./analysisTypes";
import type {
  SavePageBlocksRequest,
  SavePagesBlocksRequest,
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportPreview,
  WorkShareImportRequest,
  WorkShareImportResult,
} from "./shareTypes";
import {
  ChapterSnapshotSchema,
  CreateImportRequestSchema,
  LibraryIndexSchema,
  SavePageBlocksRequestSchema,
  SavePagesBlocksRequestSchema,
  WorkShareExportRequestSchema,
  WorkShareImportRequestSchema,
} from "./ipcSchemas";
import {
  DismissSoundEffectReviewRegionRequestSchema,
  PrepareSoundEffectTranslationPageSchema,
  PrepareSoundEffectTranslationRequestSchema,
} from "./ipcSoundEffectReviewSchemas";
import {
  defineIpcContract,
  diagnosticString,
  localPathResult,
  MAX_ID_LIST_LENGTH,
  MAX_PAGES_PER_REQUEST,
  MAX_PATH_LENGTH,
  MAX_TITLE_LENGTH,
  nonNegativeInteger,
  stringArg,
  stringListArg,
  titleString,
} from "./ipcContractCore";

const importSourceKindSchema = z.enum([
  "images",
  "folder",
  "zip",
  "rar",
  "pdf",
  "zip-folder",
]);
const importPageDraftSchema = z
  .object({
    name: z.string().min(1).max(260),
    sourcePath: localPathResult,
    sourceKind: z.enum(["file", "zip-entry"]),
    zipEntryName: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
    storageStem: z
      .string()
      .regex(/^[1-9]\d{0,5}$/)
      .optional(),
    sourceFileName: z.string().min(1).max(260).optional(),
    sourceRelativePath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  })
  .strict();
const importChapterDraftSchema = z
  .object({
    draftId: stringArg,
    title: titleString,
    sourceKind: importSourceKindSchema,
    pages: z.array(importPageDraftSchema).max(MAX_PAGES_PER_REQUEST),
  })
  .strict();
const importPreviewExcludedPageSchema = z
  .object({
    chapterTitle: titleString,
    pageName: z.string().min(1).max(260),
    reason: z.literal("invalid-image-header"),
  })
  .strict();
const importPreviewSessionSchema = z
  .object({
    previewId: stringArg,
    mode: z.enum(["single", "batch"]),
    sourceKind: importSourceKindSchema,
    suggestedWorkTitle: titleString,
    chapters: z.array(importChapterDraftSchema).max(MAX_ID_LIST_LENGTH),
    excludedPages: z
      .array(importPreviewExcludedPageSchema)
      .max(MAX_PAGES_PER_REQUEST)
      .optional(),
  })
  .strict();
const droppedImportRejectionReasonSchema = z.enum([
  "busy",
  "cancelled",
  "empty",
  "too-many-items",
  "folder-must-be-alone",
  "archive-must-be-alone",
  "pdf-must-be-alone",
  "unsupported-files",
  "folder-no-images",
  "archive-no-images",
  "pdf-no-pages",
]);
const droppedImportPreviewResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      preview: importPreviewSessionSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: droppedImportRejectionReasonSchema,
      names: z.array(z.string().min(1).max(260)).max(3).optional(),
      count: nonNegativeInteger.optional(),
    })
    .strict(),
]);
const createImportResultSchema = z
  .object({
    workId: stringArg,
    chapterIds: stringListArg,
    openedChapter: ChapterSnapshotSchema.optional(),
    linkedWorkspaceConnectedChapterIds: stringListArg.optional(),
    linkedWorkspaceWarning: diagnosticString.optional(),
  })
  .strict();
const workShareExportResultSchema = z
  .object({
    filePath: localPathResult,
    workTitle: titleString,
    chapterCount: nonNegativeInteger,
    pageCount: nonNegativeInteger,
  })
  .strict();
const workSharePreviewChapterSchema = z
  .object({
    packageChapterId: stringArg,
    title: titleString,
    pageCount: nonNegativeInteger,
  })
  .strict();
const workShareImportPreviewSchema = z
  .object({
    previewId: stringArg,
    workTitle: titleString,
    chapters: z.array(workSharePreviewChapterSchema).max(MAX_ID_LIST_LENGTH),
  })
  .strict();
const workShareImportResultSchema = z
  .object({
    workId: stringArg,
    chapterIds: stringListArg,
    openedChapter: ChapterSnapshotSchema.optional(),
  })
  .strict();

const preparedSoundEffectTargetSchema = z
  .object({
    pageId: PrepareSoundEffectTranslationPageSchema.shape.pageId,
    pageRevision: PrepareSoundEffectTranslationPageSchema.shape.pageRevision,
    regionIds: z
      .array(z.string().min(1).max(80))
      .min(1)
      .max(MAX_ID_LIST_LENGTH)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();

const prepareSoundEffectTranslationResultSchema = z
  .object({
    chapter: ChapterSnapshotSchema,
    targets: z
      .array(preparedSoundEffectTargetSchema)
      .max(MAX_PAGES_PER_REQUEST),
    includedRegionCount: nonNegativeInteger,
    dismissedRegionCount: nonNegativeInteger,
  })
  .strict();

export const importShareIpcContracts = {
  previewImagesImport: defineIpcContract<[], ImportPreviewSession | null>({
    apiKey: "previewImagesImport",
    channel: "import:preview-images",
    args: z.tuple([]),
    result: importPreviewSessionSchema.nullable(),
  }),
  previewFolderImport: defineIpcContract<[], ImportPreviewSession | null>({
    apiKey: "previewFolderImport",
    channel: "import:preview-folder",
    args: z.tuple([]),
    result: importPreviewSessionSchema.nullable(),
  }),
  previewZipImport: defineIpcContract<[], ImportPreviewSession | null>({
    apiKey: "previewZipImport",
    channel: "import:preview-zip",
    args: z.tuple([]),
    result: importPreviewSessionSchema.nullable(),
  }),
  previewPdfImport: defineIpcContract<[], ImportPreviewSession | null>({
    apiKey: "previewPdfImport",
    channel: "import:preview-pdf",
    args: z.tuple([]),
    result: importPreviewSessionSchema.nullable(),
  }),
  previewZipFolderImport: defineIpcContract<[], ImportPreviewSession | null>({
    apiKey: "previewZipFolderImport",
    channel: "import:preview-zip-folder",
    args: z.tuple([]),
    result: importPreviewSessionSchema.nullable(),
  }),
  previewDroppedImport: defineIpcContract<
    [string[]],
    DroppedImportPreviewResponse
  >({
    apiKey: "previewDroppedImport",
    channel: "import:preview-dropped",
    args: z.tuple([stringListArg]),
    result: droppedImportPreviewResponseSchema,
  }),
  createImport: defineIpcContract<[CreateImportRequest], CreateImportResult>({
    apiKey: "createImport",
    channel: "import:create",
    args: z.tuple([CreateImportRequestSchema]),
    result: createImportResultSchema,
  }),
  exportWorkShare: defineIpcContract<
    [WorkShareExportRequest],
    WorkShareExportResult | null
  >({
    apiKey: "exportWorkShare",
    channel: "share:export-work",
    args: z.tuple([WorkShareExportRequestSchema]),
    result: workShareExportResultSchema.nullable(),
  }),
  previewWorkShareImport: defineIpcContract<[], WorkShareImportPreview | null>({
    apiKey: "previewWorkShareImport",
    channel: "share:preview-import",
    args: z.tuple([]),
    result: workShareImportPreviewSchema.nullable(),
  }),
  importWorkShare: defineIpcContract<
    [WorkShareImportRequest],
    WorkShareImportResult
  >({
    apiKey: "importWorkShare",
    channel: "share:import",
    args: z.tuple([WorkShareImportRequestSchema]),
    result: workShareImportResultSchema,
  }),
} as const;

type OpenLibraryFolderResult = {
  opened: boolean;
  libraryPath: string;
  error?: string;
};
const openLibraryFolderResultSchema = z
  .object({
    opened: z.boolean(),
    libraryPath: localPathResult,
    error: diagnosticString.optional(),
  })
  .strict();

export const libraryIpcContracts = {
  getLibrary: defineIpcContract<[], LibraryIndex>({
    apiKey: "getLibrary",
    channel: "library:get-index",
    args: z.tuple([]),
    result: LibraryIndexSchema,
  }),
  openLibraryFolder: defineIpcContract<[], OpenLibraryFolderResult>({
    apiKey: "openLibraryFolder",
    channel: "library:open-folder",
    args: z.tuple([]),
    result: openLibraryFolderResultSchema,
  }),
  openChapter: defineIpcContract<[string], ChapterSnapshot>({
    apiKey: "openChapter",
    channel: "library:open-chapter",
    args: z.tuple([stringArg]),
    result: ChapterSnapshotSchema,
  }),
  getPageImageDataUrl: defineIpcContract<[string], string>({
    apiKey: "getPageImageDataUrl",
    channel: "library:get-page-image-data-url",
    args: z.tuple([stringArg]),
    result: z.string(),
  }),
  savePageBlocks: defineIpcContract<[SavePageBlocksRequest], ChapterSnapshot>({
    apiKey: "savePageBlocks",
    channel: "library:save-page-blocks",
    args: z.tuple([SavePageBlocksRequestSchema]),
    result: ChapterSnapshotSchema,
  }),
  savePagesBlocks: defineIpcContract<[SavePagesBlocksRequest], ChapterSnapshot>(
    {
      apiKey: "savePagesBlocks",
      channel: "library:save-pages-blocks",
      args: z.tuple([SavePagesBlocksRequestSchema]),
      result: ChapterSnapshotSchema,
    },
  ),
  renameWork: defineIpcContract<[string, string], LibraryIndex>({
    apiKey: "renameWork",
    channel: "library:rename-work",
    args: z.tuple([stringArg, z.string().max(MAX_TITLE_LENGTH)]),
    result: LibraryIndexSchema,
  }),
  renameChapter: defineIpcContract<[string, string], LibraryIndex>({
    apiKey: "renameChapter",
    channel: "library:rename-chapter",
    args: z.tuple([stringArg, z.string().max(MAX_TITLE_LENGTH)]),
    result: LibraryIndexSchema,
  }),
  deleteWork: defineIpcContract<[string], LibraryIndex>({
    apiKey: "deleteWork",
    channel: "library:delete-work",
    args: z.tuple([stringArg]),
    result: LibraryIndexSchema,
  }),
  deleteChapter: defineIpcContract<[string], LibraryIndex>({
    apiKey: "deleteChapter",
    channel: "library:delete-chapter",
    args: z.tuple([stringArg]),
    result: LibraryIndexSchema,
  }),
  reorderChapters: defineIpcContract<[string, string[]], LibraryIndex>({
    apiKey: "reorderChapters",
    channel: "library:reorder-chapters",
    args: z.tuple([stringArg, stringListArg]),
    result: LibraryIndexSchema,
  }),
  reorderPages: defineIpcContract<[string, string[]], ChapterSnapshot>({
    apiKey: "reorderPages",
    channel: "library:reorder-pages",
    args: z.tuple([stringArg, stringListArg]),
    result: ChapterSnapshotSchema,
  }),
  deletePage: defineIpcContract<[string, string], ChapterSnapshot>({
    apiKey: "deletePage",
    channel: "library:delete-page",
    args: z.tuple([stringArg, stringArg]),
    result: ChapterSnapshotSchema,
  }),
  dismissSoundEffectReviewRegion: defineIpcContract<
    [string, string, string],
    ChapterSnapshot
  >({
    apiKey: "dismissSoundEffectReviewRegion",
    channel: "library:dismiss-sound-effect-review-region",
    args: z.tuple([
      DismissSoundEffectReviewRegionRequestSchema.shape.chapterId,
      DismissSoundEffectReviewRegionRequestSchema.shape.pageId,
      DismissSoundEffectReviewRegionRequestSchema.shape.regionId,
    ]),
    result: ChapterSnapshotSchema,
  }),
  prepareSoundEffectTranslation: defineIpcContract<
    [PrepareSoundEffectTranslationRequest],
    PrepareSoundEffectTranslationResult
  >({
    apiKey: "prepareSoundEffectTranslation",
    channel: "library:prepare-sound-effect-translation",
    args: z.tuple([PrepareSoundEffectTranslationRequestSchema]),
    result: prepareSoundEffectTranslationResultSchema,
  }),
} as const;
