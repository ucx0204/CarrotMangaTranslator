/* eslint-disable max-lines -- Central IPC registry is intentionally table-shaped. */
import { z } from "zod";
import type {
  RegionAnalysisRequest,
  RegionAnalysisResult,
  StartAnalysisRequest,
  StartAnalysisResult,
} from "./analysisTypes";
import type {
  CreateImportRequest,
  CreateImportResult,
  ImportPreviewSession,
} from "./importTypes";
import type {
  InpaintingColorSampleRequest,
  InpaintingColorSampleResult,
  InpaintingExportRequest,
  InpaintingExportResult,
  InpaintingRetouchRequest,
  InpaintingRetouchResult,
  InpaintingRevertRequest,
  InpaintingRevertResult,
  SetPageInpaintingResultRequest,
  SetPageInpaintingResultResult,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "./inpaintingTypes";
import type {
  JobEvent,
  LocalModelPickResult,
  ModelTestProgressEvent,
  ModelTestResult,
} from "./jobTypes";
import type { ChapterSnapshot, CustomFont, LibraryIndex } from "./libraryTypes";
import type { MangaApi } from "./mangaApi";
import type {
  ExportReviewTextRequest,
  ImportReviewTextRequest,
  ImportReviewTextResult,
} from "./reviewTypes";
import type { AppSettings } from "./settingsTypes";
import type {
  SavePageBlocksRequest,
  SaveTextFileRequest,
  SaveTextFileResult,
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportPreview,
  WorkShareImportRequest,
  WorkShareImportResult,
} from "./shareTypes";
import {
  AnalyzeWorkContextRequestSchema,
  AppSettingsSchema,
  ChapterSnapshotSchema,
  ChapterStoryMemorySchema,
  CreateImportRequestSchema,
  ExportReviewTextRequestSchema,
  ImportReviewTextRequestSchema,
  InpaintingColorSampleRequestSchema,
  InpaintingExportRequestSchema,
  InpaintingRetouchRequestSchema,
  InpaintingRevertRequestSchema,
  JobEventSchema,
  LibraryIndexSchema,
  ModelTestProgressEventSchema,
  RegionAnalysisRequestSchema,
  SavePageBlocksRequestSchema,
  SaveTextFileRequestSchema,
  SetPageInpaintingResultRequestSchema,
  StartAnalysisRequestSchema,
  StartInpaintingRequestSchema,
  WorkShareExportRequestSchema,
  WorkShareImportRequestSchema,
  WorkStyleGuideSchema,
} from "./ipcSchemas";
import type {
  AnalyzeWorkContextRequest,
  AnalyzeWorkContextResult,
} from "./workContextAnalysisTypes";
import type { ChapterStoryMemory, WorkStyleGuide } from "./workContextTypes";

export type IpcContract<
  TArgs extends unknown[] = unknown[],
  TResult = unknown,
> = {
  apiKey: keyof MangaApi;
  channel: string;
  args: z.ZodType<unknown>;
  result: z.ZodType<unknown>;
  _args?: TArgs;
  _result?: TResult;
};

export type IpcEventContract<TPayload = unknown> = {
  eventKey: string;
  channel: string;
  payload: z.ZodType<unknown>;
  _payload?: TPayload;
};

function defineIpcContract<TArgs extends unknown[], TResult>(
  contract: Omit<IpcContract<TArgs, TResult>, "_args" | "_result">,
): IpcContract<TArgs, TResult> {
  return contract;
}

function defineIpcEventContract<TPayload>(
  contract: Omit<IpcEventContract<TPayload>, "_payload">,
): IpcEventContract<TPayload> {
  return contract;
}

const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 240;
const MAX_ID_LIST_LENGTH = 2000;
const MAX_PAGES_PER_REQUEST = 2000;
const MAX_BLOCKS_PER_RESULT = 500;
const MAX_WARNINGS = 500;
const MAX_DIAGNOSTIC_LENGTH = 100000;

const stringArg = z.string().min(1).max(MAX_PATH_LENGTH);
const titleString = z.string().max(MAX_TITLE_LENGTH);
const diagnosticString = z.string().max(MAX_DIAGNOSTIC_LENGTH);
const stringListArg = z.array(z.string().min(1).max(MAX_PATH_LENGTH)).max(2000);
const nonNegativeInteger = z.number().int().min(0);
const importSourceKindSchema = z.enum([
  "images",
  "folder",
  "zip",
  "zip-folder",
]);
const analysisResultStatusSchema = z.enum(["completed", "cancelled", "failed"]);
const localPathResult = z.string().min(1).max(MAX_PATH_LENGTH);
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const logMessageSchema = z.string().min(1).max(1000);

const openLibraryFolderResultSchema = z
  .object({
    opened: z.boolean(),
    libraryPath: localPathResult,
    error: diagnosticString.optional(),
  })
  .strict();

const openedUrlResultSchema = z
  .object({
    opened: z.boolean(),
    url: z.string().min(1).max(2000),
  })
  .strict();

const appUpdateInfoResultSchema = z
  .object({
    currentVersion: z.string().min(1).max(64),
    releasesUrl: z.string().min(1).max(2000),
  })
  .strict();

const openLogFolderResultSchema = z
  .object({
    opened: z.boolean(),
    logPath: localPathResult,
  })
  .strict();

const loggedResultSchema = z.object({ logged: z.boolean() }).strict();
const cancelJobResultSchema = z.object({ cancelled: z.boolean() }).strict();
const disposeInpaintingResultSchema = z
  .object({ disposed: z.boolean() })
  .strict();

type OpenLibraryFolderResult = z.output<typeof openLibraryFolderResultSchema>;
type OpenExternalResult = z.output<typeof openedUrlResultSchema>;
type AppUpdateInfoResult = z.output<typeof appUpdateInfoResultSchema>;
type OpenLogFolderResult = z.output<typeof openLogFolderResultSchema>;
type WriteLogResult = z.output<typeof loggedResultSchema>;
type CancelJobResult = z.output<typeof cancelJobResultSchema>;
type DisposeInpaintingResult = z.output<typeof disposeInpaintingResultSchema>;

const importPageDraftSchema = z
  .object({
    name: z.string().min(1).max(260),
    sourcePath: localPathResult,
    sourceKind: z.enum(["file", "zip-entry"]),
    zipEntryName: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
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

const importPreviewSessionSchema = z
  .object({
    previewId: stringArg,
    mode: z.enum(["single", "batch"]),
    sourceKind: importSourceKindSchema,
    suggestedWorkTitle: titleString,
    chapters: z.array(importChapterDraftSchema).max(MAX_ID_LIST_LENGTH),
  })
  .strict();

const createImportResultSchema = z
  .object({
    workId: stringArg,
    chapterIds: stringListArg,
    openedChapter: ChapterSnapshotSchema.optional(),
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

const saveTextFileResultSchema = z
  .object({
    saved: z.boolean(),
    path: localPathResult.optional(),
  })
  .strict();

const importReviewTextResultSchema = z
  .object({
    chapter: ChapterSnapshotSchema,
    updatedBlockCount: nonNegativeInteger,
    skippedRowCount: nonNegativeInteger,
    warnings: z.array(diagnosticString).max(MAX_WARNINGS),
  })
  .strict();

const customFontSchema = z
  .object({
    id: stringArg,
    label: z.string().min(1).max(260),
    family: z.string().min(1).max(260),
    fileName: z.string().min(1).max(260),
  })
  .strict();

const localModelPickResultSchema = z
  .object({
    modelPath: localPathResult,
    detectedMmprojPath: localPathResult.optional(),
  })
  .strict();

const modelTestResultSchema = z
  .object({
    ok: z.boolean(),
    message: diagnosticString,
    launchMode: z.enum([
      "huggingface",
      "cached-hf",
      "local",
      "openai-codex",
      "openai-api",
    ]),
    resolvedModelPath: localPathResult.nullable().optional(),
    resolvedMmprojPath: localPathResult.nullable().optional(),
    resolvedEndpoint: z.string().min(1).max(2000).nullable().optional(),
  })
  .strict();

const startAnalysisResultSchema = z
  .object({
    status: analysisResultStatusSchema,
    chapter: ChapterSnapshotSchema.optional(),
    warnings: z.array(diagnosticString).max(MAX_WARNINGS).optional(),
    error: diagnosticString.optional(),
  })
  .strict();

const regionAnalysisResultSchema = startAnalysisResultSchema
  .extend({
    pageId: stringArg.optional(),
    blockIds: z
      .array(z.string().min(1).max(200))
      .max(MAX_BLOCKS_PER_RESULT)
      .optional(),
  })
  .strict();

const startInpaintingResultSchema = z
  .object({
    status: analysisResultStatusSchema,
    chapter: ChapterSnapshotSchema.optional(),
    pagesChanged: nonNegativeInteger.optional(),
    blocksErased: nonNegativeInteger.optional(),
    error: diagnosticString.optional(),
  })
  .strict();

const inpaintingRetouchResultSchema = z
  .object({
    chapter: ChapterSnapshotSchema,
    pageId: stringArg,
  })
  .strict();

const inpaintingRevertResultSchema = z
  .object({
    chapter: ChapterSnapshotSchema,
    pagesChanged: nonNegativeInteger,
  })
  .strict();

const inpaintingColorSampleResultSchema = z
  .object({
    color: z.string().min(1).max(40),
  })
  .strict();

const inpaintingExportResultSchema = z
  .object({
    outputDir: localPathResult,
    pageCount: nonNegativeInteger,
    openError: diagnosticString.optional(),
  })
  .strict();

const workContextAnalysisScopeSchema = z.enum(["chapter", "work", "missing"]);

const analyzeWorkContextResultSchema = z
  .object({
    styleGuide: WorkStyleGuideSchema,
    storyMemory: ChapterStoryMemorySchema,
    coverage: z
      .object({
        scope: workContextAnalysisScopeSchema,
        workId: stringArg,
        requestedChapterId: stringArg,
        totalChapters: nonNegativeInteger,
        includedChapters: nonNegativeInteger,
        totalPages: nonNegativeInteger,
        includedPages: nonNegativeInteger,
        selectedChars: nonNegativeInteger,
        maxInputChars: nonNegativeInteger,
        truncated: z.boolean(),
      })
      .strict(),
    counts: z
      .object({
        glossaryAdded: nonNegativeInteger,
        glossaryUpdated: nonNegativeInteger,
        charactersAdded: nonNegativeInteger,
        charactersUpdated: nonNegativeInteger,
        rulesUpdated: nonNegativeInteger,
        pageSummariesUpserted: nonNegativeInteger,
      })
      .strict(),
    warnings: z.array(diagnosticString).max(MAX_WARNINGS),
  })
  .strict();

const optionalModelTestArgsSchema = z.union([
  z.tuple([AppSettingsSchema]),
  z.tuple([AppSettingsSchema, z.unknown()]),
]);

const writeLogArgsSchema = z.union([
  z.tuple([logLevelSchema, logMessageSchema]),
  z.tuple([logLevelSchema, logMessageSchema, z.unknown()]),
]);

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
  previewZipFolderImport: defineIpcContract<[], ImportPreviewSession | null>({
    apiKey: "previewZipFolderImport",
    channel: "import:preview-zip-folder",
    args: z.tuple([]),
    result: importPreviewSessionSchema.nullable(),
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
} as const;

export const workContextIpcContracts = {
  getWorkStyleGuide: defineIpcContract<[string], WorkStyleGuide>({
    apiKey: "getWorkStyleGuide",
    channel: "context:get-work-style-guide",
    args: z.tuple([stringArg]),
    result: WorkStyleGuideSchema,
  }),
  saveWorkStyleGuide: defineIpcContract<[WorkStyleGuide], WorkStyleGuide>({
    apiKey: "saveWorkStyleGuide",
    channel: "context:save-work-style-guide",
    args: z.tuple([WorkStyleGuideSchema]),
    result: WorkStyleGuideSchema,
  }),
  getChapterStoryMemory: defineIpcContract<[string], ChapterStoryMemory>({
    apiKey: "getChapterStoryMemory",
    channel: "context:get-chapter-story-memory",
    args: z.tuple([stringArg]),
    result: ChapterStoryMemorySchema,
  }),
  saveChapterStoryMemory: defineIpcContract<
    [ChapterStoryMemory],
    ChapterStoryMemory
  >({
    apiKey: "saveChapterStoryMemory",
    channel: "context:save-chapter-story-memory",
    args: z.tuple([ChapterStoryMemorySchema]),
    result: ChapterStoryMemorySchema,
  }),
  analyzeWorkContext: defineIpcContract<
    [AnalyzeWorkContextRequest],
    AnalyzeWorkContextResult
  >({
    apiKey: "analyzeWorkContext",
    channel: "context:analyze-work-context",
    args: z.tuple([AnalyzeWorkContextRequestSchema]),
    result: analyzeWorkContextResultSchema,
  }),
} as const;

export const textReviewIpcContracts = {
  saveTextFile: defineIpcContract<
    [SaveTextFileRequest],
    SaveTextFileResult | null
  >({
    apiKey: "saveTextFile",
    channel: "text:save-file",
    args: z.tuple([SaveTextFileRequestSchema]),
    result: saveTextFileResultSchema.nullable(),
  }),
  exportReviewText: defineIpcContract<
    [ExportReviewTextRequest],
    SaveTextFileResult | null
  >({
    apiKey: "exportReviewText",
    channel: "review:export-text",
    args: z.tuple([ExportReviewTextRequestSchema]),
    result: saveTextFileResultSchema.nullable(),
  }),
  importReviewText: defineIpcContract<
    [ImportReviewTextRequest],
    ImportReviewTextResult
  >({
    apiKey: "importReviewText",
    channel: "review:import-text",
    args: z.tuple([ImportReviewTextRequestSchema]),
    result: importReviewTextResultSchema,
  }),
} as const;

export const fontIpcContracts = {
  listCustomFonts: defineIpcContract<[], CustomFont[]>({
    apiKey: "listCustomFonts",
    channel: "fonts:list",
    args: z.tuple([]),
    result: z.array(customFontSchema).max(500),
  }),
  registerCustomFont: defineIpcContract<[], CustomFont | null>({
    apiKey: "registerCustomFont",
    channel: "fonts:register",
    args: z.tuple([]),
    result: customFontSchema.nullable(),
  }),
  removeCustomFont: defineIpcContract<[string], CustomFont[]>({
    apiKey: "removeCustomFont",
    channel: "fonts:remove",
    args: z.tuple([stringArg]),
    result: z.array(customFontSchema).max(500),
  }),
} as const;

export const settingsIpcContracts = {
  getSettings: defineIpcContract<[], AppSettings>({
    apiKey: "getSettings",
    channel: "settings:get",
    args: z.tuple([]),
    result: AppSettingsSchema,
  }),
  saveSettings: defineIpcContract<[AppSettings], AppSettings>({
    apiKey: "saveSettings",
    channel: "settings:save",
    args: z.tuple([AppSettingsSchema]),
    result: AppSettingsSchema,
  }),
  resetSettings: defineIpcContract<[], AppSettings>({
    apiKey: "resetSettings",
    channel: "settings:reset",
    args: z.tuple([]),
    result: AppSettingsSchema,
  }),
  pickLocalModelFile: defineIpcContract<[], LocalModelPickResult | null>({
    apiKey: "pickLocalModelFile",
    channel: "settings:pick-local-model",
    args: z.tuple([]),
    result: localModelPickResultSchema.nullable(),
  }),
  pickLocalMmprojFile: defineIpcContract<[], string | null>({
    apiKey: "pickLocalMmprojFile",
    channel: "settings:pick-local-mmproj",
    args: z.tuple([]),
    result: localPathResult.nullable(),
  }),
  testModelSettings: defineIpcContract<
    [AppSettings, providedTestId?: unknown],
    ModelTestResult
  >({
    apiKey: "testModelSettings",
    channel: "settings:test-model",
    args: optionalModelTestArgsSchema,
    result: modelTestResultSchema,
  }),
} as const;

export const externalIpcContracts = {
  openAmdHipSdkDownload: defineIpcContract<[], OpenExternalResult>({
    apiKey: "openAmdHipSdkDownload",
    channel: "external:open-amd-hip-sdk",
    args: z.tuple([]),
    result: openedUrlResultSchema,
  }),
  getAppUpdateInfo: defineIpcContract<[], AppUpdateInfoResult>({
    apiKey: "getAppUpdateInfo",
    channel: "external:get-update-info",
    args: z.tuple([]),
    result: appUpdateInfoResultSchema,
  }),
  openReleasesPage: defineIpcContract<[], OpenExternalResult>({
    apiKey: "openReleasesPage",
    channel: "external:open-releases",
    args: z.tuple([]),
    result: openedUrlResultSchema,
  }),
} as const;

export const logsIpcContracts = {
  getLogPath: defineIpcContract<[], string>({
    apiKey: "getLogPath",
    channel: "logs:get-path",
    args: z.tuple([]),
    result: localPathResult,
  }),
  openLogFolder: defineIpcContract<[], OpenLogFolderResult>({
    apiKey: "openLogFolder",
    channel: "logs:open-folder",
    args: z.tuple([]),
    result: openLogFolderResultSchema,
  }),
  writeLog: defineIpcContract<
    [
      level: "debug" | "info" | "warn" | "error",
      message: string,
      detail?: unknown,
    ],
    WriteLogResult
  >({
    apiKey: "writeLog",
    channel: "logs:write",
    args: writeLogArgsSchema,
    result: loggedResultSchema,
  }),
} as const;

export const translationJobIpcContracts = {
  startAnalysis: defineIpcContract<[StartAnalysisRequest], StartAnalysisResult>(
    {
      apiKey: "startAnalysis",
      channel: "job:start-analysis",
      args: z.tuple([StartAnalysisRequestSchema]),
      result: startAnalysisResultSchema,
    },
  ),
  translateRegion: defineIpcContract<
    [RegionAnalysisRequest],
    RegionAnalysisResult
  >({
    apiKey: "translateRegion",
    channel: "job:translate-region",
    args: z.tuple([RegionAnalysisRequestSchema]),
    result: regionAnalysisResultSchema,
  }),
} as const;

export const inpaintingIpcContracts = {
  startInpainting: defineIpcContract<
    [StartInpaintingRequest],
    StartInpaintingResult
  >({
    apiKey: "startInpainting",
    channel: "job:start-inpainting",
    args: z.tuple([StartInpaintingRequestSchema]),
    result: startInpaintingResultSchema,
  }),
  applyInpaintingRetouch: defineIpcContract<
    [InpaintingRetouchRequest],
    InpaintingRetouchResult
  >({
    apiKey: "applyInpaintingRetouch",
    channel: "inpainting:apply-retouch",
    args: z.tuple([InpaintingRetouchRequestSchema]),
    result: inpaintingRetouchResultSchema,
  }),
  setPageInpaintingResult: defineIpcContract<
    [SetPageInpaintingResultRequest],
    SetPageInpaintingResultResult
  >({
    apiKey: "setPageInpaintingResult",
    channel: "inpainting:set-page-result",
    args: z.tuple([SetPageInpaintingResultRequestSchema]),
    result: inpaintingRetouchResultSchema,
  }),
  revertInpainting: defineIpcContract<
    [InpaintingRevertRequest],
    InpaintingRevertResult
  >({
    apiKey: "revertInpainting",
    channel: "inpainting:revert",
    args: z.tuple([InpaintingRevertRequestSchema]),
    result: inpaintingRevertResultSchema,
  }),
  sampleInpaintingColor: defineIpcContract<
    [InpaintingColorSampleRequest],
    InpaintingColorSampleResult
  >({
    apiKey: "sampleInpaintingColor",
    channel: "inpainting:sample-color",
    args: z.tuple([InpaintingColorSampleRequestSchema]),
    result: inpaintingColorSampleResultSchema,
  }),
  exportInpaintingResults: defineIpcContract<
    [InpaintingExportRequest],
    InpaintingExportResult
  >({
    apiKey: "exportInpaintingResults",
    channel: "inpainting:export-results",
    args: z.tuple([InpaintingExportRequestSchema]),
    result: inpaintingExportResultSchema,
  }),
  disposeInpaintingEngine: defineIpcContract<[], DisposeInpaintingResult>({
    apiKey: "disposeInpaintingEngine",
    channel: "inpainting:dispose-engine",
    args: z.tuple([]),
    result: disposeInpaintingResultSchema,
  }),
} as const;

export const jobControlIpcContracts = {
  cancelJob: defineIpcContract<[], CancelJobResult>({
    apiKey: "cancelJob",
    channel: "job:cancel",
    args: z.tuple([]),
    result: cancelJobResultSchema,
  }),
} as const;

export const ipcInvokeContracts = {
  ...importShareIpcContracts,
  ...libraryIpcContracts,
  ...workContextIpcContracts,
  ...textReviewIpcContracts,
  ...fontIpcContracts,
  ...settingsIpcContracts,
  ...externalIpcContracts,
  ...logsIpcContracts,
  ...translationJobIpcContracts,
  ...inpaintingIpcContracts,
  ...jobControlIpcContracts,
} as const;

export const ipcEventContracts = {
  jobEvent: defineIpcEventContract<JobEvent>({
    eventKey: "jobEvent",
    channel: "job:event",
    payload: JobEventSchema,
  }),
  modelTestProgress: defineIpcEventContract<ModelTestProgressEvent>({
    eventKey: "modelTestProgress",
    channel: "settings:model-test-progress",
    payload: ModelTestProgressEventSchema,
  }),
} as const;

export type IpcInvokeContractName = keyof typeof ipcInvokeContracts;
export type LibraryIpcContractName = keyof typeof libraryIpcContracts;
