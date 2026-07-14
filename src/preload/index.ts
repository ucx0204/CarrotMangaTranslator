import { contextBridge, ipcRenderer } from "electron";
import type { MangaApi } from "../shared/mangaApi";
import {
  externalIpcContracts,
  fontIpcContracts,
  importShareIpcContracts,
  inpaintingIpcContracts,
  ipcEventContracts,
  jobControlIpcContracts,
  libraryIpcContracts,
  logsIpcContracts,
  panelWindowIpcContracts,
  pageImageExportIpcContracts,
  settingsIpcContracts,
  textReviewIpcContracts,
  translationJobIpcContracts,
  workContextIpcContracts,
  type IpcEventContract,
} from "../shared/ipcContracts";
import type {
  PanelCommand,
  PanelId,
  PanelSyncState,
} from "../shared/panelBridgeTypes";
import { invokeContract } from "./ipcContracts";
import type {
  RegionAnalysisRequest,
  RegionAnalysisResult,
  StartAnalysisRequest,
  StartAnalysisResult,
} from "../shared/analysisTypes";
import type {
  CreateImportRequest,
  CreateImportResult,
  ImportPreviewSession,
} from "../shared/importTypes";
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
} from "../shared/inpaintingTypes";
import type {
  PageImageExportRequest,
  PageImageExportResult,
} from "../shared/pageImageExportTypes";
import type {
  JobEvent,
  LocalModelPickResult,
  ModelTestProgressEvent,
  ModelTestResult,
} from "../shared/jobTypes";
import type {
  ChapterSnapshot,
  CustomFont,
  LibraryIndex,
} from "../shared/libraryTypes";
import type {
  ExportReviewTextRequest,
  ImportReviewTextRequest,
  ImportReviewTextResult,
} from "../shared/reviewTypes";
import type { AppSettings } from "../shared/settingsTypes";
import type {
  ApiModelDiscoveryRequest,
  ApiModelDiscoveryResult,
  DiscoverableApiProviderId,
} from "../shared/apiProviderPresets";
import type {
  SavePageBlocksRequest,
  SaveTextFileRequest,
  SaveTextFileResult,
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportPreview,
  WorkShareImportRequest,
  WorkShareImportResult,
} from "../shared/shareTypes";
import type {
  AnalyzeWorkContextRequest,
  AnalyzeWorkContextResult,
} from "../shared/workContextAnalysisTypes";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../shared/workContextTypes";

function subscribeToIpcEvent<TPayload>(
  contract: IpcEventContract<TPayload>,
  callback: (payload: TPayload) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
    const result = contract.payload.safeParse(payload);
    if (result.success) {
      callback(result.data as TPayload);
      return;
    }
    console.warn(`Invalid ${contract.eventKey} payload ignored`);
  };
  ipcRenderer.on(contract.channel, listener);
  return () => {
    ipcRenderer.removeListener(contract.channel, listener);
  };
}

const api = {
  previewImagesImport: (): Promise<ImportPreviewSession | null> =>
    invokeContract(importShareIpcContracts.previewImagesImport),
  previewFolderImport: (): Promise<ImportPreviewSession | null> =>
    invokeContract(importShareIpcContracts.previewFolderImport),
  previewZipImport: (): Promise<ImportPreviewSession | null> =>
    invokeContract(importShareIpcContracts.previewZipImport),
  previewZipFolderImport: (): Promise<ImportPreviewSession | null> =>
    invokeContract(importShareIpcContracts.previewZipFolderImport),
  createImport: (request: CreateImportRequest): Promise<CreateImportResult> =>
    invokeContract(importShareIpcContracts.createImport, request),
  exportWorkShare: (
    request: WorkShareExportRequest,
  ): Promise<WorkShareExportResult | null> =>
    invokeContract(importShareIpcContracts.exportWorkShare, request),
  previewWorkShareImport: (): Promise<WorkShareImportPreview | null> =>
    invokeContract(importShareIpcContracts.previewWorkShareImport),
  importWorkShare: (
    request: WorkShareImportRequest,
  ): Promise<WorkShareImportResult> =>
    invokeContract(importShareIpcContracts.importWorkShare, request),
  getLibrary: (): Promise<LibraryIndex> =>
    invokeContract(libraryIpcContracts.getLibrary),
  openLibraryFolder: () =>
    invokeContract(libraryIpcContracts.openLibraryFolder),
  openChapter: (chapterId: string): Promise<ChapterSnapshot> =>
    invokeContract(libraryIpcContracts.openChapter, chapterId),
  getWorkStyleGuide: (workId: string): Promise<WorkStyleGuide> =>
    invokeContract(workContextIpcContracts.getWorkStyleGuide, workId),
  saveWorkStyleGuide: (guide: WorkStyleGuide): Promise<WorkStyleGuide> =>
    invokeContract(workContextIpcContracts.saveWorkStyleGuide, guide),
  getChapterStoryMemory: (chapterId: string): Promise<ChapterStoryMemory> =>
    invokeContract(workContextIpcContracts.getChapterStoryMemory, chapterId),
  saveChapterStoryMemory: (
    memory: ChapterStoryMemory,
  ): Promise<ChapterStoryMemory> =>
    invokeContract(workContextIpcContracts.saveChapterStoryMemory, memory),
  analyzeWorkContext: (
    request: AnalyzeWorkContextRequest,
  ): Promise<AnalyzeWorkContextResult> =>
    invokeContract(workContextIpcContracts.analyzeWorkContext, request),
  getPageImageDataUrl: (imagePath: string): Promise<string> =>
    invokeContract(libraryIpcContracts.getPageImageDataUrl, imagePath),
  savePageBlocks: (request: SavePageBlocksRequest): Promise<ChapterSnapshot> =>
    invokeContract(libraryIpcContracts.savePageBlocks, request),
  saveTextFile: (
    request: SaveTextFileRequest,
  ): Promise<SaveTextFileResult | null> =>
    invokeContract(textReviewIpcContracts.saveTextFile, request),
  exportReviewText: (
    request: ExportReviewTextRequest,
  ): Promise<SaveTextFileResult | null> =>
    invokeContract(textReviewIpcContracts.exportReviewText, request),
  importReviewText: (
    request: ImportReviewTextRequest,
  ): Promise<ImportReviewTextResult> =>
    invokeContract(textReviewIpcContracts.importReviewText, request),
  renameWork: (workId: string, title: string): Promise<LibraryIndex> =>
    invokeContract(libraryIpcContracts.renameWork, workId, title),
  renameChapter: (chapterId: string, title: string): Promise<LibraryIndex> =>
    invokeContract(libraryIpcContracts.renameChapter, chapterId, title),
  deleteWork: (workId: string): Promise<LibraryIndex> =>
    invokeContract(libraryIpcContracts.deleteWork, workId),
  deleteChapter: (chapterId: string): Promise<LibraryIndex> =>
    invokeContract(libraryIpcContracts.deleteChapter, chapterId),
  reorderChapters: (
    workId: string,
    chapterIds: string[],
  ): Promise<LibraryIndex> =>
    invokeContract(libraryIpcContracts.reorderChapters, workId, chapterIds),
  reorderPages: (
    chapterId: string,
    pageIds: string[],
  ): Promise<ChapterSnapshot> =>
    invokeContract(libraryIpcContracts.reorderPages, chapterId, pageIds),
  deletePage: (chapterId: string, pageId: string): Promise<ChapterSnapshot> =>
    invokeContract(libraryIpcContracts.deletePage, chapterId, pageId),
  listCustomFonts: (): Promise<CustomFont[]> =>
    invokeContract(fontIpcContracts.listCustomFonts),
  registerCustomFont: (): Promise<CustomFont | null> =>
    invokeContract(fontIpcContracts.registerCustomFont),
  removeCustomFont: (id: string): Promise<CustomFont[]> =>
    invokeContract(fontIpcContracts.removeCustomFont, id),
  getUiLocale: () => invokeContract(settingsIpcContracts.getUiLocale),
  getSettings: (): Promise<AppSettings> =>
    invokeContract(settingsIpcContracts.getSettings),
  saveSettings: (settings: AppSettings): Promise<AppSettings> =>
    invokeContract(settingsIpcContracts.saveSettings, settings),
  resetSettings: (): Promise<AppSettings> =>
    invokeContract(settingsIpcContracts.resetSettings),
  pickLocalModelFile: (): Promise<LocalModelPickResult | null> =>
    invokeContract(settingsIpcContracts.pickLocalModelFile),
  pickLocalMmprojFile: (): Promise<string | null> =>
    invokeContract(settingsIpcContracts.pickLocalMmprojFile),
  openAmdHipSdkDownload: () =>
    invokeContract(externalIpcContracts.openAmdHipSdkDownload),
  getAppUpdateInfo: () => invokeContract(externalIpcContracts.getAppUpdateInfo),
  openReleasesPage: () => invokeContract(externalIpcContracts.openReleasesPage),
  testModelSettings: (
    settings: AppSettings,
    testId?: string,
  ): Promise<ModelTestResult> =>
    invokeContract(settingsIpcContracts.testModelSettings, settings, testId),
  discoverApiModels: (
    request: ApiModelDiscoveryRequest,
  ): Promise<ApiModelDiscoveryResult> =>
    invokeContract(settingsIpcContracts.discoverApiModels, request),
  openApiProviderPage: (provider: DiscoverableApiProviderId) =>
    invokeContract(externalIpcContracts.openApiProviderPage, provider),
  getLogPath: (): Promise<string> =>
    invokeContract(logsIpcContracts.getLogPath),
  openLogFolder: () => invokeContract(logsIpcContracts.openLogFolder),
  writeLog: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    detail?: unknown,
  ) => invokeContract(logsIpcContracts.writeLog, level, message, detail),
  startAnalysis: (
    request: StartAnalysisRequest,
  ): Promise<StartAnalysisResult> =>
    invokeContract(translationJobIpcContracts.startAnalysis, request),
  translateRegion: (
    request: RegionAnalysisRequest,
  ): Promise<RegionAnalysisResult> =>
    invokeContract(translationJobIpcContracts.translateRegion, request),
  startInpainting: (
    request: StartInpaintingRequest,
  ): Promise<StartInpaintingResult> =>
    invokeContract(inpaintingIpcContracts.startInpainting, request),
  applyInpaintingRetouch: (
    request: InpaintingRetouchRequest,
  ): Promise<InpaintingRetouchResult> =>
    invokeContract(inpaintingIpcContracts.applyInpaintingRetouch, request),
  setPageInpaintingResult: (
    request: SetPageInpaintingResultRequest,
  ): Promise<SetPageInpaintingResultResult> =>
    invokeContract(inpaintingIpcContracts.setPageInpaintingResult, request),
  revertInpainting: (
    request: InpaintingRevertRequest,
  ): Promise<InpaintingRevertResult> =>
    invokeContract(inpaintingIpcContracts.revertInpainting, request),
  applyInpaintingHistoryTransaction: (
    request: ApplyInpaintingHistoryTransactionRequest,
  ): Promise<ApplyInpaintingHistoryTransactionResult> =>
    invokeContract(
      inpaintingIpcContracts.applyInpaintingHistoryTransaction,
      request,
    ),
  releaseInpaintingHistoryTransactions: (
    request: ReleaseInpaintingHistoryTransactionsRequest,
  ): Promise<ReleaseInpaintingHistoryTransactionsResult> =>
    invokeContract(
      inpaintingIpcContracts.releaseInpaintingHistoryTransactions,
      request,
    ),
  sampleInpaintingColor: (
    request: InpaintingColorSampleRequest,
  ): Promise<InpaintingColorSampleResult> =>
    invokeContract(inpaintingIpcContracts.sampleInpaintingColor, request),
  exportPageImages: (
    request: PageImageExportRequest,
  ): Promise<PageImageExportResult | null> =>
    invokeContract(pageImageExportIpcContracts.exportPageImages, request),
  disposeInpaintingEngine: (): Promise<{ disposed: boolean }> =>
    invokeContract(inpaintingIpcContracts.disposeInpaintingEngine),
  cancelJob: () => invokeContract(jobControlIpcContracts.cancelJob),
  getPanelState: () => invokeContract(panelWindowIpcContracts.getPanelState),
  openPanelWindow: (panelId: PanelId) =>
    invokeContract(panelWindowIpcContracts.openPanelWindow, panelId),
  closePanelWindow: (panelId: PanelId) =>
    invokeContract(panelWindowIpcContracts.closePanelWindow, panelId),
  publishPanelState: (state: PanelSyncState) =>
    invokeContract(panelWindowIpcContracts.publishPanelState, state),
  sendPanelCommand: (command: PanelCommand) =>
    invokeContract(panelWindowIpcContracts.sendPanelCommand, command),
  onPanelState: (callback: (state: PanelSyncState) => void) =>
    subscribeToIpcEvent(ipcEventContracts.panelState, callback),
  onPanelCommand: (callback: (command: PanelCommand) => void) =>
    subscribeToIpcEvent(ipcEventContracts.panelCommand, callback),
  onPanelWindowsChanged: (callback: (openPanelIds: PanelId[]) => void) =>
    subscribeToIpcEvent(ipcEventContracts.panelWindowsChanged, callback),
  onJobEvent: (callback: (event: JobEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const result = ipcEventContracts.jobEvent.payload.safeParse(payload);
      if (result.success) {
        callback(result.data as JobEvent);
        return;
      }
      console.warn("Invalid job event payload ignored");
    };
    ipcRenderer.on(ipcEventContracts.jobEvent.channel, listener);
    return () => {
      ipcRenderer.removeListener(ipcEventContracts.jobEvent.channel, listener);
    };
  },
  onModelTestEvent: (callback: (event: ModelTestProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const result =
        ipcEventContracts.modelTestProgress.payload.safeParse(payload);
      if (result.success) {
        callback(result.data as ModelTestProgressEvent);
        return;
      }
      console.warn("Invalid model test progress payload ignored");
    };
    ipcRenderer.on(ipcEventContracts.modelTestProgress.channel, listener);
    return () => {
      ipcRenderer.removeListener(
        ipcEventContracts.modelTestProgress.channel,
        listener,
      );
    };
  },
  onUiLocaleChanged: (callback) =>
    subscribeToIpcEvent(ipcEventContracts.uiLocaleChanged, callback),
} satisfies MangaApi;

contextBridge.exposeInMainWorld("mangaApi", api);
