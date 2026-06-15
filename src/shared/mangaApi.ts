import type {
  AppSettings,
  ChapterSnapshot,
  CreateImportRequest,
  CreateImportResult,
  CustomFont,
  ImportPreviewSession,
  InpaintingColorSampleRequest,
  InpaintingColorSampleResult,
  InpaintingExportRequest,
  InpaintingExportResult,
  InpaintingRetouchRequest,
  InpaintingRetouchResult,
  InpaintingRevertRequest,
  InpaintingRevertResult,
  JobEvent,
  LibraryIndex,
  LocalModelPickResult,
  ModelTestProgressEvent,
  ModelTestResult,
  RegionAnalysisRequest,
  RegionAnalysisResult,
  SavePageBlocksRequest,
  SetPageInpaintingResultRequest,
  SetPageInpaintingResultResult,
  StartAnalysisRequest,
  StartAnalysisResult,
  StartInpaintingRequest,
  StartInpaintingResult,
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportPreview,
  WorkShareImportRequest,
  WorkShareImportResult,
} from "./types";

export type MangaApi = {
  previewImagesImport: () => Promise<ImportPreviewSession | null>;
  previewFolderImport: () => Promise<ImportPreviewSession | null>;
  previewZipImport: () => Promise<ImportPreviewSession | null>;
  previewZipFolderImport: () => Promise<ImportPreviewSession | null>;
  createImport: (request: CreateImportRequest) => Promise<CreateImportResult>;
  exportWorkShare: (
    request: WorkShareExportRequest,
  ) => Promise<WorkShareExportResult | null>;
  previewWorkShareImport: () => Promise<WorkShareImportPreview | null>;
  importWorkShare: (
    request: WorkShareImportRequest,
  ) => Promise<WorkShareImportResult>;
  getLibrary: () => Promise<LibraryIndex>;
  openLibraryFolder: () => Promise<unknown>;
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  getPageImageDataUrl: (imagePath: string) => Promise<string>;
  savePageBlocks: (request: SavePageBlocksRequest) => Promise<ChapterSnapshot>;
  renameWork: (workId: string, title: string) => Promise<LibraryIndex>;
  renameChapter: (chapterId: string, title: string) => Promise<LibraryIndex>;
  deleteWork: (workId: string) => Promise<LibraryIndex>;
  deleteChapter: (chapterId: string) => Promise<LibraryIndex>;
  reorderChapters: (
    workId: string,
    chapterIds: string[],
  ) => Promise<LibraryIndex>;
  reorderPages: (
    chapterId: string,
    pageIds: string[],
  ) => Promise<ChapterSnapshot>;
  deletePage: (chapterId: string, pageId: string) => Promise<ChapterSnapshot>;
  listCustomFonts: () => Promise<CustomFont[]>;
  registerCustomFont: () => Promise<CustomFont | null>;
  removeCustomFont: (id: string) => Promise<CustomFont[]>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  resetSettings: () => Promise<AppSettings>;
  pickLocalModelFile: () => Promise<LocalModelPickResult | null>;
  pickLocalMmprojFile: () => Promise<string | null>;
  testModelSettings: (
    settings: AppSettings,
    testId?: string,
  ) => Promise<ModelTestResult>;
  getLogPath: () => Promise<string>;
  openLogFolder: () => Promise<unknown>;
  writeLog: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    detail?: unknown,
  ) => Promise<unknown>;
  startAnalysis: (
    request: StartAnalysisRequest,
  ) => Promise<StartAnalysisResult>;
  translateRegion: (
    request: RegionAnalysisRequest,
  ) => Promise<RegionAnalysisResult>;
  startInpainting: (
    request: StartInpaintingRequest,
  ) => Promise<StartInpaintingResult>;
  applyInpaintingRetouch: (
    request: InpaintingRetouchRequest,
  ) => Promise<InpaintingRetouchResult>;
  setPageInpaintingResult: (
    request: SetPageInpaintingResultRequest,
  ) => Promise<SetPageInpaintingResultResult>;
  revertInpainting: (
    request: InpaintingRevertRequest,
  ) => Promise<InpaintingRevertResult>;
  sampleInpaintingColor: (
    request: InpaintingColorSampleRequest,
  ) => Promise<InpaintingColorSampleResult>;
  exportInpaintingResults: (
    request: InpaintingExportRequest,
  ) => Promise<InpaintingExportResult>;
  disposeInpaintingEngine: () => Promise<{ disposed: boolean }>;
  cancelJob: () => Promise<unknown>;
  onJobEvent: (callback: (event: JobEvent) => void) => () => void;
  onModelTestEvent: (
    callback: (event: ModelTestProgressEvent) => void,
  ) => () => void;
};
