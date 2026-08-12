import type {
  AnalyzeWorkContextRequest,
  AnalyzeWorkContextResult,
} from "./workContextAnalysisTypes";
import type {
  ApplyInpaintingHistoryTransactionRequest,
  ApplyInpaintingHistoryTransactionResult,
  InpaintingColorSampleRequest,
  InpaintingColorSampleResult,
  InpaintingRetouchRequest,
  InpaintingRetouchResult,
  InpaintingRevertRequest,
  InpaintingRevertResult,
  ReleaseInpaintingHistoryTransactionsRequest,
  ReleaseInpaintingHistoryTransactionsResult,
  SetPageInpaintingResultRequest,
  SetPageInpaintingResultResult,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "./inpaintingTypes";
import type {
  PageImageExportPreflightResult,
  PageImageExportRequest,
  PageImageExportResult,
} from "./pageImageExportTypes";
import type {
  JobEvent,
  LocalModelPickResult,
  ModelTestProgressEvent,
  ModelTestResult,
} from "./jobTypes";
import type {
  ChapterSnapshot,
  CustomFont,
  FontLibrarySnapshot,
  FontPreferences,
  LibraryIndex,
} from "./libraryTypes";
import type { PanelCommand, PanelId, PanelSyncState } from "./panelBridgeTypes";
import type {
  RegionAnalysisRequest,
  RegionAnalysisResult,
  StartAnalysisRequest,
  StartAnalysisResult,
} from "./analysisTypes";
import type {
  SavePageBlocksRequest,
  SavePagesBlocksRequest,
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
  DroppedImportPreviewResponse,
  ImportPreviewSession,
} from "./importTypes";
import type {
  ChapterStoryMemory,
  ResetWorkContextRequest,
  ResetWorkContextResult,
  WorkStyleGuide,
} from "./workContextTypes";
import type { WorkContextUsage } from "./workContextUsageTypes";
import type { AppSettings, UiLocale } from "./settingsTypes";
import type {
  ApiModelDiscoveryRequest,
  ApiModelDiscoveryResult,
  DiscoverableApiProviderId,
} from "./apiProviderPresets";
import type {
  CopyErrorReportResult,
  ErrorReportContext,
  ErrorReportDraft,
  OpenErrorReportIssueRequest,
  OpenErrorReportIssueResult,
  RestartAppResult,
} from "./errorReportTypes";
import type { BuildChannel, RuntimeCapabilities } from "./runtimeCapabilities";

export type MangaApi = {
  getPathForFile: (file: File) => string;
  previewImagesImport: () => Promise<ImportPreviewSession | null>;
  previewFolderImport: () => Promise<ImportPreviewSession | null>;
  previewZipImport: () => Promise<ImportPreviewSession | null>;
  previewZipFolderImport: () => Promise<ImportPreviewSession | null>;
  previewDroppedImport: (
    filePaths: string[],
  ) => Promise<DroppedImportPreviewResponse>;
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
  resetWorkContext: (
    request: ResetWorkContextRequest,
  ) => Promise<ResetWorkContextResult>;
  getWorkContextUsage: (workId: string) => Promise<WorkContextUsage>;
  analyzeWorkContext: (
    request: AnalyzeWorkContextRequest,
  ) => Promise<AnalyzeWorkContextResult>;
  getPageImageDataUrl: (imagePath: string) => Promise<string>;
  savePageBlocks: (request: SavePageBlocksRequest) => Promise<ChapterSnapshot>;
  savePagesBlocks: (
    request: SavePagesBlocksRequest,
  ) => Promise<ChapterSnapshot>;
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
  getFontLibrary: () => Promise<FontLibrarySnapshot>;
  saveFontPreferences: (
    preferences: FontPreferences,
  ) => Promise<FontLibrarySnapshot>;
  listCustomFonts: () => Promise<CustomFont[]>;
  registerCustomFont: () => Promise<CustomFont | null>;
  removeCustomFont: (id: string) => Promise<CustomFont[]>;
  getUiLocale: () => Promise<UiLocale>;
  getSettings: () => Promise<AppSettings>;
  getDefaultSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  resetSettings: () => Promise<AppSettings>;
  pickLocalModelFile: () => Promise<LocalModelPickResult | null>;
  pickLocalMmprojFile: () => Promise<string | null>;
  openAmdHipSdkDownload: () => Promise<unknown>;
  getAppUpdateInfo: () => Promise<{
    currentVersion: string;
    releasesUrl: string;
    buildChannel: BuildChannel;
  }>;
  getRuntimeCapabilities: () => Promise<RuntimeCapabilities>;
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
  prepareErrorReport: (
    context: ErrorReportContext,
  ) => Promise<ErrorReportDraft>;
  copyErrorReport: (body: string) => Promise<CopyErrorReportResult>;
  openErrorReportIssue: (
    request: OpenErrorReportIssueRequest,
  ) => Promise<OpenErrorReportIssueResult>;
  restartApp: () => Promise<RestartAppResult>;
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
  applyInpaintingHistoryTransaction: (
    request: ApplyInpaintingHistoryTransactionRequest,
  ) => Promise<ApplyInpaintingHistoryTransactionResult>;
  releaseInpaintingHistoryTransactions: (
    request: ReleaseInpaintingHistoryTransactionsRequest,
  ) => Promise<ReleaseInpaintingHistoryTransactionsResult>;
  sampleInpaintingColor: (
    request: InpaintingColorSampleRequest,
  ) => Promise<InpaintingColorSampleResult>;
  exportPageImages: (
    request: PageImageExportRequest,
  ) => Promise<PageImageExportResult | null>;
  preflightPageImages: (
    request: PageImageExportRequest,
  ) => Promise<PageImageExportPreflightResult>;
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
  onFontLibraryChanged: (
    callback: (snapshot: FontLibrarySnapshot) => void,
  ) => () => void;
  onPanelState: (callback: (state: PanelSyncState) => void) => () => void;
  onPanelCommand: (callback: (command: PanelCommand) => void) => () => void;
  onPanelWindowsChanged: (
    callback: (openPanelIds: PanelId[]) => void,
  ) => () => void;
  onErrorIncident: (
    callback: (context: ErrorReportContext) => void,
  ) => () => void;
};
