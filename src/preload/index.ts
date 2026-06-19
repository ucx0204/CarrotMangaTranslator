import { contextBridge, ipcRenderer } from "electron";
import type { MangaApi } from "../shared/mangaApi";
import {
  isJobKind,
  isJobPhase,
  isJobStatus,
  isProgressMode,
} from "../shared/jobContracts";
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
  SaveTextFileRequest,
  SaveTextFileResult,
  SetPageInpaintingResultRequest,
  SetPageInpaintingResultResult,
  StartInpaintingRequest,
  StartInpaintingResult,
  StartAnalysisRequest,
  StartAnalysisResult,
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportPreview,
  WorkShareImportRequest,
  WorkShareImportResult,
} from "../shared/types";

const api = {
  previewImagesImport: (): Promise<ImportPreviewSession | null> =>
    ipcRenderer.invoke("import:preview-images"),
  previewFolderImport: (): Promise<ImportPreviewSession | null> =>
    ipcRenderer.invoke("import:preview-folder"),
  previewZipImport: (): Promise<ImportPreviewSession | null> =>
    ipcRenderer.invoke("import:preview-zip"),
  previewZipFolderImport: (): Promise<ImportPreviewSession | null> =>
    ipcRenderer.invoke("import:preview-zip-folder"),
  createImport: (request: CreateImportRequest): Promise<CreateImportResult> =>
    ipcRenderer.invoke("import:create", request),
  exportWorkShare: (
    request: WorkShareExportRequest,
  ): Promise<WorkShareExportResult | null> =>
    ipcRenderer.invoke("share:export-work", request),
  previewWorkShareImport: (): Promise<WorkShareImportPreview | null> =>
    ipcRenderer.invoke("share:preview-import"),
  importWorkShare: (
    request: WorkShareImportRequest,
  ): Promise<WorkShareImportResult> =>
    ipcRenderer.invoke("share:import", request),
  getLibrary: (): Promise<LibraryIndex> =>
    ipcRenderer.invoke("library:get-index"),
  openLibraryFolder: () => ipcRenderer.invoke("library:open-folder"),
  openChapter: (chapterId: string): Promise<ChapterSnapshot> =>
    ipcRenderer.invoke("library:open-chapter", chapterId),
  getPageImageDataUrl: (imagePath: string): Promise<string> =>
    ipcRenderer.invoke("library:get-page-image-data-url", imagePath),
  savePageBlocks: (request: SavePageBlocksRequest): Promise<ChapterSnapshot> =>
    ipcRenderer.invoke("library:save-page-blocks", request),
  saveTextFile: (
    request: SaveTextFileRequest,
  ): Promise<SaveTextFileResult | null> =>
    ipcRenderer.invoke("text:save-file", request),
  renameWork: (workId: string, title: string): Promise<LibraryIndex> =>
    ipcRenderer.invoke("library:rename-work", workId, title),
  renameChapter: (chapterId: string, title: string): Promise<LibraryIndex> =>
    ipcRenderer.invoke("library:rename-chapter", chapterId, title),
  deleteWork: (workId: string): Promise<LibraryIndex> =>
    ipcRenderer.invoke("library:delete-work", workId),
  deleteChapter: (chapterId: string): Promise<LibraryIndex> =>
    ipcRenderer.invoke("library:delete-chapter", chapterId),
  reorderChapters: (
    workId: string,
    chapterIds: string[],
  ): Promise<LibraryIndex> =>
    ipcRenderer.invoke("library:reorder-chapters", workId, chapterIds),
  reorderPages: (
    chapterId: string,
    pageIds: string[],
  ): Promise<ChapterSnapshot> =>
    ipcRenderer.invoke("library:reorder-pages", chapterId, pageIds),
  deletePage: (chapterId: string, pageId: string): Promise<ChapterSnapshot> =>
    ipcRenderer.invoke("library:delete-page", chapterId, pageId),
  listCustomFonts: (): Promise<CustomFont[]> =>
    ipcRenderer.invoke("fonts:list"),
  registerCustomFont: (): Promise<CustomFont | null> =>
    ipcRenderer.invoke("fonts:register"),
  removeCustomFont: (id: string): Promise<CustomFont[]> =>
    ipcRenderer.invoke("fonts:remove", id),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke("settings:save", settings),
  resetSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke("settings:reset"),
  pickLocalModelFile: (): Promise<LocalModelPickResult | null> =>
    ipcRenderer.invoke("settings:pick-local-model"),
  pickLocalMmprojFile: (): Promise<string | null> =>
    ipcRenderer.invoke("settings:pick-local-mmproj"),
  openAmdHipSdkDownload: () => ipcRenderer.invoke("external:open-amd-hip-sdk"),
  testModelSettings: (
    settings: AppSettings,
    testId?: string,
  ): Promise<ModelTestResult> =>
    ipcRenderer.invoke("settings:test-model", settings, testId),
  getLogPath: (): Promise<string> => ipcRenderer.invoke("logs:get-path"),
  openLogFolder: () => ipcRenderer.invoke("logs:open-folder"),
  writeLog: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    detail?: unknown,
  ) => ipcRenderer.invoke("logs:write", level, message, detail),
  startAnalysis: (
    request: StartAnalysisRequest,
  ): Promise<StartAnalysisResult> =>
    ipcRenderer.invoke("job:start-analysis", request),
  translateRegion: (
    request: RegionAnalysisRequest,
  ): Promise<RegionAnalysisResult> =>
    ipcRenderer.invoke("job:translate-region", request),
  startInpainting: (
    request: StartInpaintingRequest,
  ): Promise<StartInpaintingResult> =>
    ipcRenderer.invoke("job:start-inpainting", request),
  applyInpaintingRetouch: (
    request: InpaintingRetouchRequest,
  ): Promise<InpaintingRetouchResult> =>
    ipcRenderer.invoke("inpainting:apply-retouch", request),
  setPageInpaintingResult: (
    request: SetPageInpaintingResultRequest,
  ): Promise<SetPageInpaintingResultResult> =>
    ipcRenderer.invoke("inpainting:set-page-result", request),
  revertInpainting: (
    request: InpaintingRevertRequest,
  ): Promise<InpaintingRevertResult> =>
    ipcRenderer.invoke("inpainting:revert", request),
  sampleInpaintingColor: (
    request: InpaintingColorSampleRequest,
  ): Promise<InpaintingColorSampleResult> =>
    ipcRenderer.invoke("inpainting:sample-color", request),
  exportInpaintingResults: (
    request: InpaintingExportRequest,
  ): Promise<InpaintingExportResult> =>
    ipcRenderer.invoke("inpainting:export-results", request),
  disposeInpaintingEngine: (): Promise<{ disposed: boolean }> =>
    ipcRenderer.invoke("inpainting:dispose-engine"),
  cancelJob: () => ipcRenderer.invoke("job:cancel"),
  onJobEvent: (callback: (event: JobEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (isJobEvent(payload)) {
        callback(payload);
        return;
      }
      console.warn("Invalid job:event payload ignored");
    };
    ipcRenderer.on("job:event", listener);
    return () => {
      ipcRenderer.removeListener("job:event", listener);
    };
  },
  onModelTestEvent: (callback: (event: ModelTestProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (isModelTestProgressEvent(payload)) {
        callback(payload);
        return;
      }
      console.warn("Invalid settings:model-test-progress payload ignored");
    };
    ipcRenderer.on("settings:model-test-progress", listener);
    return () => {
      ipcRenderer.removeListener("settings:model-test-progress", listener);
    };
  },
} satisfies MangaApi;

contextBridge.exposeInMainWorld("mangaApi", api);

function isJobEvent(value: unknown): value is JobEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isBoundedString(value.id, 1, 200) &&
    isJobKind(value.kind) &&
    isJobStatus(value.status) &&
    isBoundedString(value.progressText, 1, 1000) &&
    isOptionalBoundedString(value.detail, 4000) &&
    isOptionalJobPhase(value.phase) &&
    isOptionalProgressMode(value.progressMode) &&
    isOptionalFiniteNumber(value.progressPercent, 0, 1) &&
    isOptionalFiniteNumber(value.progressBytes, 0) &&
    isOptionalFiniteNumber(value.progressTotalBytes, 0) &&
    isOptionalFiniteNumber(value.progressBytesPerSecond, 0) &&
    isOptionalBoundedString(value.installLogLine, 4000) &&
    isOptionalStringArray(value.installLogLines, 500, 4000) &&
    isOptionalFiniteNumber(value.progressCurrent, 0) &&
    isOptionalFiniteNumber(value.progressTotal, 0) &&
    isOptionalFiniteNumber(value.pageIndex, 0) &&
    isOptionalFiniteNumber(value.pageTotal, 0) &&
    isOptionalFiniteNumber(value.attempt, 0) &&
    isOptionalFiniteNumber(value.attemptTotal, 0)
  );
}

function isModelTestProgressEvent(
  value: unknown,
): value is ModelTestProgressEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isBoundedString(value.id, 1, 200) &&
    isBoundedString(value.progressText, 1, 1000) &&
    isOptionalBoundedString(value.detail, 4000) &&
    isOptionalJobPhase(value.phase) &&
    isOptionalProgressMode(value.progressMode) &&
    isOptionalFiniteNumber(value.progressPercent, 0, 1) &&
    isOptionalFiniteNumber(value.progressBytes, 0) &&
    isOptionalFiniteNumber(value.progressTotalBytes, 0) &&
    isOptionalFiniteNumber(value.progressBytesPerSecond, 0) &&
    isOptionalBoundedString(value.installLogLine, 4000)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  minLength: number,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minLength &&
    value.length <= maxLength
  );
}

function isOptionalBoundedString(
  value: unknown,
  maxLength: number,
): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && value.length <= maxLength)
  );
}

function isOptionalJobPhase(value: unknown): boolean {
  return value === undefined || isJobPhase(value);
}

function isOptionalProgressMode(value: unknown): boolean {
  return value === undefined || isProgressMode(value);
}

function isOptionalFiniteNumber(
  value: unknown,
  min: number,
  max = Number.POSITIVE_INFINITY,
): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max)
  );
}

function isOptionalStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= maxItems &&
      value.every(
        (item) => typeof item === "string" && item.length <= maxLength,
      ))
  );
}
