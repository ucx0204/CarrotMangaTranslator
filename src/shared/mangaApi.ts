import type {
  ResearchWorkContextRequest,
  WorkContextResearchProposal,
} from "./workContextResearchTypes";
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
  PageExportSelectionRequest,
  PagePsdExportRequest,
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
  SaveWorkResearchTitleRequest,
  WorkStyleGuide,
  WorkResearchTitlePreference,
} from "./workContextTypes";
import type { WorkContextUsage } from "./workContextUsageTypes";
import type { AppSettings, UiLocale } from "./settingsTypes";
import type {
  ApiModelDiscoveryRequest,
  ApiModelDiscoveryResult,
  DiscoverableApiProviderId,
  VertexSetupPageId,
  VertexServiceAccountPickResult,
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
import type {
  PrepareWebImportRequest,
  WebImportBooleanResult,
  WebImportProgressEvent,
  WebImportScanRequest,
  WebImportScanResponse,
} from "./webImportTypes";
import type {
  BlockLibraryEntryV1,
  BlockLibrarySnapshotV1,
  RenameBlockLibraryEntryInput,
  SaveBlockLibraryEntryInput,
  UpdateBlockLibraryEntryInput,
} from "./blockLibrary";
import type {
  ConnectLinkedWorkspaceRequest,
  LinkedWorkspaceActivityRequest,
  LinkedWorkspaceBooleanResult,
  LinkedWorkspaceStatus,
  LinkedWorkspaceStatusChangedEvent,
  UpdateLinkedWorkspaceRequest,
  ViewLinkedResultsRequest,
  ViewLinkedResultsResult,
} from "./linkedWorkspaceTypes";
import type { CodexAccountSnapshot } from "./codexAccountTypes";
import type {
  FinishPageTimingSessionRequest,
  FinishPageTimingSessionResult,
  PageTimingUpdatedEvent,
} from "./pageProcessingTiming";
import type {
  TavilyUsageRequest,
  TavilyUsageSnapshot,
} from "./internetResearchTypes";

export type MangaApi = {
  getLinkedWorkspaceStatus: (
    chapterId: string,
  ) => Promise<LinkedWorkspaceStatus>;
  listLinkedWorkspaceStatuses: (
    chapterIds: string[],
  ) => Promise<LinkedWorkspaceStatus[]>;
  connectLinkedWorkspace: (
    request: ConnectLinkedWorkspaceRequest,
  ) => Promise<LinkedWorkspaceStatus | null>;
  updateLinkedWorkspace: (
    request: UpdateLinkedWorkspaceRequest,
  ) => Promise<LinkedWorkspaceStatus>;
  reconnectLinkedWorkspace: (
    connectionId: string,
  ) => Promise<LinkedWorkspaceStatus | null>;
  resetLinkedWorkspaceLocation: (
    connectionId: string,
  ) => Promise<LinkedWorkspaceStatus>;
  disconnectLinkedWorkspace: (
    connectionId: string,
  ) => Promise<LinkedWorkspaceBooleanResult>;
  viewLinkedResults: (
    request: ViewLinkedResultsRequest,
  ) => Promise<ViewLinkedResultsResult>;
  reportLinkedWorkspaceActivity: (
    request: LinkedWorkspaceActivityRequest,
  ) => Promise<LinkedWorkspaceBooleanResult>;
  listBlockLibraryEntries: () => Promise<BlockLibrarySnapshotV1>;
  saveBlockLibraryEntry: (
    input: SaveBlockLibraryEntryInput,
  ) => Promise<BlockLibrarySnapshotV1>;
  renameBlockLibraryEntry: (
    input: RenameBlockLibraryEntryInput,
  ) => Promise<BlockLibrarySnapshotV1>;
  updateBlockLibraryEntry: (
    input: UpdateBlockLibraryEntryInput,
  ) => Promise<BlockLibrarySnapshotV1>;
  deleteBlockLibraryEntry: (id: string) => Promise<BlockLibrarySnapshotV1>;
  useBlockLibraryEntry: (id: string) => Promise<BlockLibraryEntryV1>;
  getPathForFile: (file: File) => string;
  previewImagesImport: () => Promise<ImportPreviewSession | null>;
  previewFolderImport: () => Promise<ImportPreviewSession | null>;
  previewZipImport: () => Promise<ImportPreviewSession | null>;
  previewZipFolderImport: () => Promise<ImportPreviewSession | null>;
  previewDroppedImport: (
    filePaths: string[],
  ) => Promise<DroppedImportPreviewResponse>;
  createImport: (request: CreateImportRequest) => Promise<CreateImportResult>;
  scanWebImport: (
    request: WebImportScanRequest,
  ) => Promise<WebImportScanResponse>;
  cancelWebImportScan: (requestId: string) => Promise<WebImportBooleanResult>;
  discardWebImportSession: (
    sessionId: string,
  ) => Promise<WebImportBooleanResult>;
  prepareWebImport: (
    request: PrepareWebImportRequest,
  ) => Promise<ImportPreviewSession>;
  discardImportPreview: (previewId: string) => Promise<WebImportBooleanResult>;
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
  getWorkResearchTitle: (
    workId: string,
  ) => Promise<WorkResearchTitlePreference | null>;
  saveWorkResearchTitle: (
    request: SaveWorkResearchTitleRequest,
  ) => Promise<WorkResearchTitlePreference>;
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
  researchWorkContext: (
    request: ResearchWorkContextRequest,
  ) => Promise<WorkContextResearchProposal>;
  cancelWorkContextResearch: (runId: string) => Promise<{ cancelled: boolean }>;
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
  getCodexAccount: () => Promise<CodexAccountSnapshot>;
  loginCodexAccount: () => Promise<CodexAccountSnapshot>;
  logoutCodexAccount: () => Promise<CodexAccountSnapshot>;
  getTavilyUsage: (
    request?: TavilyUsageRequest,
  ) => Promise<TavilyUsageSnapshot>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  resetSettings: () => Promise<AppSettings>;
  pickLocalModelFile: () => Promise<LocalModelPickResult | null>;
  pickLocalMmprojFile: () => Promise<string | null>;
  pickVertexServiceAccountFile: () => Promise<VertexServiceAccountPickResult | null>;
  openAmdHipSdkDownload: () => Promise<unknown>;
  getAppUpdateInfo: () => Promise<{
    currentVersion: string;
    releasesUrl: string;
    buildChannel: BuildChannel;
  }>;
  getRuntimeCapabilities: () => Promise<RuntimeCapabilities>;
  openReleasesPage: () => Promise<unknown>;
  openResearchSource: (
    url: string,
  ) => Promise<{ opened: boolean; url: string }>;
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
  openVertexSetupPage: (
    page: VertexSetupPageId,
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
  exportPagePsd: (
    request: PagePsdExportRequest,
  ) => Promise<PageImageExportResult | null>;
  preflightPageImages: (
    request: PageExportSelectionRequest,
  ) => Promise<PageImageExportPreflightResult>;
  disposeInpaintingEngine: () => Promise<{ disposed: boolean }>;
  cancelJob: () => Promise<unknown>;
  finishPageTimingSession: (
    request: FinishPageTimingSessionRequest,
  ) => Promise<FinishPageTimingSessionResult>;
  getPanelState: () => Promise<PanelSyncState | null>;
  openPanelWindow: (panelId: PanelId) => Promise<{ opened: boolean }>;
  closePanelWindow: (panelId: PanelId) => Promise<{ closed: boolean }>;
  publishPanelState: (state: PanelSyncState) => Promise<{ published: boolean }>;
  sendPanelCommand: (command: PanelCommand) => Promise<{ sent: boolean }>;
  onJobEvent: (callback: (event: JobEvent) => void) => () => void;
  onPageTimingUpdated: (
    callback: (event: PageTimingUpdatedEvent) => void,
  ) => () => void;
  onModelTestEvent: (
    callback: (event: ModelTestProgressEvent) => void,
  ) => () => void;
  onWebImportProgress: (
    callback: (event: WebImportProgressEvent) => void,
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
  onLinkedWorkspaceStatusChanged: (
    callback: (event: LinkedWorkspaceStatusChangedEvent) => void,
  ) => () => void;
};
