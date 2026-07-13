import type {
  AnalyzeWorkContextRequest,
  AnalyzeWorkContextResult,
} from "./workContextAnalysisTypes";
import type {
  InpaintingColorSampleRequest,
  InpaintingColorSampleResult,
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
  PageImageExportRequest,
  PageImageExportResult,
} from "./pageImageExportTypes";
import type {
  JobEvent,
  LocalModelPickResult,
  ModelTestProgressEvent,
  ModelTestResult,
} from "./jobTypes";
import type { ChapterSnapshot, CustomFont, LibraryIndex } from "./libraryTypes";
import type { PanelCommand, PanelId, PanelSyncState } from "./panelBridgeTypes";
import type {
  RegionAnalysisRequest,
  RegionAnalysisResult,
  StartAnalysisRequest,
  StartAnalysisResult,
} from "./analysisTypes";
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
import type {
  ExportReviewTextRequest,
  ImportReviewTextRequest,
  ImportReviewTextResult,
} from "./reviewTypes";
import type {
  CreateImportRequest,
  CreateImportResult,
  ImportPreviewSession,
} from "./importTypes";
import type { ChapterStoryMemory, WorkStyleGuide } from "./workContextTypes";
import type { AppSettings, UiLocale } from "./settingsTypes";
import type {
  ApiModelDiscoveryRequest,
  ApiModelDiscoveryResult,
  DiscoverableApiProviderId,
} from "./apiProviderPresets";

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
  getWorkStyleGuide: (workId: string) => Promise<WorkStyleGuide>;
  saveWorkStyleGuide: (guide: WorkStyleGuide) => Promise<WorkStyleGuide>;
  getChapterStoryMemory: (chapterId: string) => Promise<ChapterStoryMemory>;
  saveChapterStoryMemory: (
    memory: ChapterStoryMemory,
  ) => Promise<ChapterStoryMemory>;
  analyzeWorkContext: (
    request: AnalyzeWorkContextRequest,
  ) => Promise<AnalyzeWorkContextResult>;
  getPageImageDataUrl: (imagePath: string) => Promise<string>;
  savePageBlocks: (request: SavePageBlocksRequest) => Promise<ChapterSnapshot>;
  saveTextFile: (
    request: SaveTextFileRequest,
  ) => Promise<SaveTextFileResult | null>;
  exportReviewText: (
    request: ExportReviewTextRequest,
  ) => Promise<SaveTextFileResult | null>;
  importReviewText: (
    request: ImportReviewTextRequest,
  ) => Promise<ImportReviewTextResult>;
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
  getUiLocale: () => Promise<UiLocale>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  resetSettings: () => Promise<AppSettings>;
  pickLocalModelFile: () => Promise<LocalModelPickResult | null>;
  pickLocalMmprojFile: () => Promise<string | null>;
  openAmdHipSdkDownload: () => Promise<unknown>;
  getAppUpdateInfo: () => Promise<{
    currentVersion: string;
    releasesUrl: string;
  }>;
  openReleasesPage: () => Promise<unknown>;
  testModelSettings: (
    settings: AppSettings,
    testId?: string,
  ) => Promise<ModelTestResult>;
  discoverApiModels: (
    request: ApiModelDiscoveryRequest,
  ) => Promise<ApiModelDiscoveryResult>;
  openApiProviderPage: (
    provider: DiscoverableApiProviderId,
  ) => Promise<{ opened: boolean; url: string }>;
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
  exportPageImages: (
    request: PageImageExportRequest,
  ) => Promise<PageImageExportResult | null>;
  disposeInpaintingEngine: () => Promise<{ disposed: boolean }>;
  cancelJob: () => Promise<unknown>;
  getPanelState: () => Promise<PanelSyncState | null>;
  openPanelWindow: (panelId: PanelId) => Promise<{ opened: boolean }>;
  closePanelWindow: (panelId: PanelId) => Promise<{ closed: boolean }>;
  publishPanelState: (state: PanelSyncState) => Promise<{ published: boolean }>;
  sendPanelCommand: (command: PanelCommand) => Promise<{ sent: boolean }>;
  onJobEvent: (callback: (event: JobEvent) => void) => () => void;
  onModelTestEvent: (
    callback: (event: ModelTestProgressEvent) => void,
  ) => () => void;
  onUiLocaleChanged: (callback: (locale: UiLocale) => void) => () => void;
  onPanelState: (callback: (state: PanelSyncState) => void) => () => void;
  onPanelCommand: (callback: (command: PanelCommand) => void) => () => void;
  onPanelWindowsChanged: (
    callback: (openPanelIds: PanelId[]) => void,
  ) => () => void;
};
