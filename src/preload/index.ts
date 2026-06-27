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
  settingsIpcContracts,
  textReviewIpcContracts,
  translationJobIpcContracts,
  workContextIpcContracts,
} from "../shared/ipcContracts";
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
} from "../shared/inpaintingTypes";
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
  sampleInpaintingColor: (
    request: InpaintingColorSampleRequest,
  ): Promise<InpaintingColorSampleResult> =>
    invokeContract(inpaintingIpcContracts.sampleInpaintingColor, request),
  exportInpaintingResults: (
    request: InpaintingExportRequest,
  ): Promise<InpaintingExportResult> =>
    invokeContract(inpaintingIpcContracts.exportInpaintingResults, request),
  disposeInpaintingEngine: (): Promise<{ disposed: boolean }> =>
    invokeContract(inpaintingIpcContracts.disposeInpaintingEngine),
  cancelJob: () => invokeContract(jobControlIpcContracts.cancelJob),
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
} satisfies MangaApi;

contextBridge.exposeInMainWorld("mangaApi", api);
