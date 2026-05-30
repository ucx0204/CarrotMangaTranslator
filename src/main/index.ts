import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, extname, join } from "node:path";
import { ensureWritableAppDirectories } from "./appPaths";
import { buildBaseTranslationOptions } from "./appSettings";
import {
  cleanupLegacyLogs,
  deleteChapter,
  deleteWork,
  createImport,
  deletePage,
  exportWorkShareToFile,
  finalizeRunningPages,
  getLibraryRoot,
  getRunPaths,
  importWorkShare,
  listLibrary,
  markChapterPagesRunning,
  openChapter,
  previewFolder,
  previewImages,
  previewWorkShareImport,
  previewZip,
  previewZipFolder,
  readLibraryPageImageDataUrl,
  renameChapter,
  renameWork,
  reorderChapters,
  reorderPages,
  resolvePagesForRun,
  saveChapterSnapshot,
  updatePageAfterAnalysis
} from "./library";
import { getLogPath, logError, logInfo, resetAppLog, writeLog } from "./logger";
import { startOpenAIOAuthEndpoint, stopOpenAIOAuthEndpoint, type OpenAIOAuthEndpoint } from "./openaiOauthEndpoint";
import { getAppSettings, resetAppSettings, saveAppSettings } from "./settingsStore";
import { runWholePagePipeline } from "./wholePagePipeline";
import type {
  AppSettings,
  CreateImportRequest,
  ImportPreviewResult,
  JobEvent,
  LocalModelPickResult,
  MangaPage,
  ModelTestProgressEvent,
  ModelTestResult,
  RegionAnalysisRequest,
  RegionAnalysisResult,
  StartAnalysisRequest,
  StartAnalysisResult,
  TranslationBlock,
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportRequest,
  WorkShareImportResult,
  WorkShareImportPreview
} from "../shared/types";
import { isUsableRegionBbox, mapCropNormalizedBboxToPageBbox, normalizedRegionToPixelRect, type PixelRect } from "../shared/region";

const appPaths = ensureWritableAppDirectories();
resetAppLog();

logInfo("Application process starting", {
  cwd: process.cwd(),
  isPackaged: app.isPackaged,
  processExecPath: process.execPath,
  logPath: getLogPath(),
  libraryPath: getLibraryRoot(),
  settingsPath: appPaths.settingsPath,
  dataRoot: appPaths.dataRoot,
  runtimeDir: appPaths.runtimeDir,
  llamaServerPath: appPaths.llamaServerPath,
  hfHomeDir: appPaths.hfHomeDir ?? null,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled rejection", reason);
});

let mainWindow: BrowserWindow | null = null;
type ActiveJob = {
  id: string;
  abortController: AbortController;
  cleanup?: () => Promise<void>;
  lastEvent?: JobEvent;
};

let activeJob: ActiveJob | null = null;

type SimplePageRuntime = {
  startServer: (options: Record<string, unknown>) => Promise<{ baseUrl: string; child: unknown; startedByScript: boolean }>;
  stopServer: (server: { child: unknown } | null | undefined) => Promise<void>;
  isModelCached: (options: Record<string, unknown>) => boolean;
  convertImageToPngBufferWithFfmpeg?: (filePath: string) => Promise<Buffer>;
  testModelReply: (server: { baseUrl: string }, options: Record<string, unknown>) => Promise<{
    outputText: string;
    launchTarget: { launchMode: "huggingface" | "cached-hf" | "local" | "openai-codex"; modelPath?: string | null; mmprojPath?: string | null };
  }>;
};

let cachedSimplePageRuntime: SimplePageRuntime | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1240,
    minHeight: 760,
    backgroundColor: "#101114",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.on("console-message", (details) => {
    const level =
      details.level === "warning" ? "warn" : details.level === "error" ? "error" : details.level === "debug" ? "debug" : "info";
    writeLog(level, "renderer console", {
      message: details.message,
      line: details.lineNumber,
      sourceId: details.sourceId
    });
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logError("Renderer failed to load", { errorCode, errorDescription, validatedURL });
  });

  mainWindow.setMenuBarVisibility(false);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  await cleanupLegacyLogs();
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (activeJob) {
    activeJob.abortController.abort();
    void runJobCleanup(activeJob, "before-quit");
  }
});

async function runJobCleanup(job: ActiveJob, reason: string): Promise<void> {
  const cleanup = job.cleanup;
  if (!cleanup) {
    return;
  }
  job.cleanup = undefined;
  try {
    await cleanup();
    logInfo("Analysis runtime cleanup completed", { jobId: job.id, reason });
  } catch (error) {
    logError("Analysis runtime cleanup failed", { jobId: job.id, reason, error });
  }
}

async function createRegionCropPage(page: MangaPage, bbox: RegionAnalysisRequest["bbox"], jobId: string, runDir: string): Promise<{
  cropPage: MangaPage;
  cropRect: PixelRect;
}> {
  if (!isUsableRegionBbox(bbox)) {
    throw new Error("번역할 영역이 너무 작습니다.");
  }

  const source = await loadImageForRegionCrop(page.imagePath);

  const cropRect = normalizedRegionToPixelRect(bbox, { width: page.width, height: page.height }, 8);
  const crop = source.crop({
    x: cropRect.x,
    y: cropRect.y,
    width: cropRect.w,
    height: cropRect.h
  });
  if (crop.isEmpty()) {
    throw new Error("선택 영역 이미지를 만들지 못했습니다.");
  }

  const cropDir = join(runDir, "region-crops");
  await mkdir(cropDir, { recursive: true });
  const cropPath = join(cropDir, `${page.id}-${jobId}.png`);
  await writeFile(cropPath, crop.toPNG());

  return {
    cropRect,
    cropPage: {
      ...page,
      id: `${page.id}-region-${jobId}`,
      name: `${page.name} 선택 영역`,
      imagePath: cropPath,
      dataUrl: "",
      width: cropRect.w,
      height: cropRect.h,
      blocks: [],
      analysisStatus: "idle",
      lastError: undefined
    }
  };
}

async function loadImageForRegionCrop(imagePath: string): Promise<Electron.NativeImage> {
  if (extname(imagePath).toLowerCase() === ".webp") {
    const runtime = loadSimplePageRuntime();
    if (runtime.convertImageToPngBufferWithFfmpeg) {
      const pngBuffer = await runtime.convertImageToPngBufferWithFfmpeg(imagePath);
      const converted = nativeImage.createFromBuffer(pngBuffer);
      if (!converted.isEmpty()) {
        logInfo("Region crop decoded webp through png conversion", { imagePath });
        return converted;
      }
    }
    throw new Error("WEBP 이미지를 PNG로 변환하지 못했습니다.");
  }

  const direct = nativeImage.createFromPath(imagePath);
  if (!direct.isEmpty()) {
    return direct;
  }

  throw new Error("선택한 페이지 이미지를 읽지 못했습니다.");
}

function mapRegionBlocksToPageBlocks(blocks: TranslationBlock[], page: MangaPage, cropRect: PixelRect): TranslationBlock[] {
  const pageSize = { width: page.width, height: page.height };
  return blocks.map((block) => {
    const id = `${page.id}-region-block-${randomUUID()}`;
    return {
      ...block,
      id,
      bbox: mapCropNormalizedBboxToPageBbox(cropRect, pageSize, block.bbox),
      renderBbox: block.renderBbox ? mapCropNormalizedBboxToPageBbox(cropRect, pageSize, block.renderBbox) : undefined,
      bboxSpace: "normalized_1000",
      renderBboxSpace: block.renderBbox ? "normalized_1000" : undefined
    };
  });
}

function registerIpc(): void {
  ipcMain.handle("logs:get-path", () => getLogPath());

  ipcMain.handle("logs:open-folder", async () => {
    await shell.showItemInFolder(getLogPath());
    return { opened: true, logPath: getLogPath() };
  });

  ipcMain.handle("logs:write", async (_event, level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown) => {
    writeLog(level, `renderer: ${message}`, detail);
    return { logged: true };
  });

  ipcMain.handle("settings:get", async () => getAppSettings());
  ipcMain.handle("settings:save", async (_event, settings: AppSettings) => saveAppSettings(settings));
  ipcMain.handle("settings:reset", async () => resetAppSettings());
  ipcMain.handle("settings:pick-local-model", async (): Promise<LocalModelPickResult | null> => {
    const options = {
      title: "로컬 GGUF 모델 선택",
      properties: ["openFile"],
      filters: [{ name: "GGUF Model", extensions: ["gguf"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    const modelPath = result.filePaths[0];
    const detectedMmprojPath = detectSiblingMmprojPath(modelPath);
    return {
      modelPath,
      ...(detectedMmprojPath ? { detectedMmprojPath } : {})
    };
  });
  ipcMain.handle("settings:pick-local-mmproj", async (): Promise<string | null> => {
    const options = {
      title: "mmproj 파일 선택",
      properties: ["openFile"],
      filters: [{ name: "GGUF Model", extensions: ["gguf"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return result.filePaths[0];
  });
  ipcMain.handle("settings:test-model", async (event, settings: AppSettings, providedTestId?: string): Promise<ModelTestResult> => {
    if (activeJob) {
      return {
        ok: false,
        message: "번역 작업 중에는 모델 테스트를 실행할 수 없습니다.",
        launchMode: resolveSettingsLaunchMode(settings)
      };
    }

    const runtime = loadSimplePageRuntime();
    const testId = typeof providedTestId === "string" && providedTestId.trim() ? providedTestId.trim() : randomUUID();
    const sendProgress = (progress: Omit<ModelTestProgressEvent, "id">) => {
      event.sender.send("settings:model-test-progress", {
        id: testId,
        ...progress
      } satisfies ModelTestProgressEvent);
    };
    const port = await reserveFreePort();
    const options = {
      ...buildBaseTranslationOptions({
        jobId: `settings-test-${testId}`,
        runDir: join(appPaths.dataRoot, "model-tests", testId),
        paths: appPaths,
        settings
      }),
      onProgress: (progress: Omit<ModelTestProgressEvent, "id">) => {
        sendProgress(progress);
      },
      reuseServer: false,
      port,
      label: `settings-test-${testId}`
    };

    let server: Awaited<ReturnType<SimplePageRuntime["startServer"]>> | OpenAIOAuthEndpoint | null = null;
    try {
      sendProgress({
        phase: "booting",
        progressText: "모델 테스트 준비 중",
        installLogLine: "모델 테스트를 시작합니다."
      });
      if (options.modelProvider === "openai-codex") {
        sendProgress({
          phase: "booting",
          progressText: "OpenAI Codex 엔드포인트 준비 중",
          detail: `${options.codexModel}, port ${options.codexOauthPort}`,
          installLogLine: "openai-oauth 엔드포인트를 시작합니다."
        });
      } else if (runtime.isModelCached(options)) {
        sendProgress({
          phase: "booting",
          progressText: "캐시된 Gemma 모델 확인됨",
          detail: options.modelFile,
          installLogLine: "캐시된 모델 파일을 사용합니다."
        });
      } else {
        sendProgress({
          phase: "model_downloading",
          progressText: "Gemma 모델 다운로드/서버 준비 중",
          detail: `${options.modelRepo} / ${options.modelFile}`,
          progressMode: "log-only",
          installLogLine: "캐시된 모델이 없어서 다운로드 또는 갱신을 시작합니다."
        });
      }
      server = options.modelProvider === "openai-codex" ? await startOpenAIOAuthEndpoint(options) : await runtime.startServer(options);
      sendProgress({
        phase: "ready",
        progressText: "서버 준비 완료",
        detail: server.baseUrl,
        installLogLine: `서버가 준비되었습니다: ${server.baseUrl}`
      });
      const result = await runtime.testModelReply(server, options);
      sendProgress({
        phase: "done",
        progressText: "모델 테스트 완료",
        detail: result.outputText,
        installLogLine: `응답 확인 완료: ${result.outputText}`
      });
      return {
        ok: true,
        message: `모델 로드 및 텍스트 응답 확인 완료: ${result.outputText}`,
        launchMode: options.modelProvider === "openai-codex" ? "openai-codex" : result.launchTarget.launchMode,
        resolvedModelPath: result.launchTarget.modelPath ?? null,
        resolvedMmprojPath: result.launchTarget.mmprojPath ?? null,
        resolvedEndpoint: options.modelProvider === "openai-codex" ? server.baseUrl : null
      };
    } catch (error) {
      sendProgress({
        phase: "failed",
        progressText: "모델 테스트 실패",
        detail: formatModelTestError(error),
        installLogLine: "모델 테스트가 실패했습니다."
      });
      return {
        ok: false,
        message: formatModelTestError(error),
        launchMode: resolveSettingsLaunchMode(settings)
      };
    } finally {
      if (isOpenAIOAuthEndpoint(server)) {
        await stopOpenAIOAuthEndpoint(server);
      } else {
        await runtime.stopServer(server);
      }
    }
  });

  ipcMain.handle("library:get-index", async () => listLibrary());
  ipcMain.handle("library:open-folder", async () => {
    await shell.openPath(getLibraryRoot());
    return { opened: true, libraryPath: getLibraryRoot() };
  });
  ipcMain.handle("library:open-chapter", async (_event, chapterId: string) => openChapter(chapterId));
  ipcMain.handle("library:get-page-image-data-url", async (_event, imagePath: string) => readLibraryPageImageDataUrl(imagePath));
  ipcMain.handle("library:save-chapter", async (_event, chapter) => saveChapterSnapshot(chapter));
  ipcMain.handle("library:rename-work", async (_event, workId: string, title: string) => renameWork(workId, title));
  ipcMain.handle("library:rename-chapter", async (_event, chapterId: string, title: string) => renameChapter(chapterId, title));
  ipcMain.handle("library:delete-work", async (_event, workId: string) => deleteWork(workId));
  ipcMain.handle("library:delete-chapter", async (_event, chapterId: string) => deleteChapter(chapterId));
  ipcMain.handle("library:reorder-chapters", async (_event, workId: string, chapterIds: string[]) => reorderChapters(workId, chapterIds));
  ipcMain.handle("library:reorder-pages", async (_event, chapterId: string, pageIds: string[]) => reorderPages(chapterId, pageIds));
  ipcMain.handle("library:delete-page", async (_event, chapterId: string, pageId: string) => deletePage(chapterId, pageId));

  ipcMain.handle("import:preview-images", async () => {
    const options = {
      title: "이미지 열기",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const preview = await previewImages(result.filePaths);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-folder", async () => {
    const options = {
      title: "이미지 폴더 열기",
      properties: ["openDirectory"]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewFolder(result.filePaths[0]);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-zip", async () => {
    const options = {
      title: "압축파일 열기",
      properties: ["openFile"],
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewZip(result.filePaths[0]);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-zip-folder", async () => {
    const options = {
      title: "작품 일괄 번역",
      properties: ["openDirectory"]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewZipFolder(result.filePaths[0]);
    return preview.chapters.length ? preview : null;
  });

  ipcMain.handle("import:create", async (_event, request: CreateImportRequest) => createImport(request));

  ipcMain.handle("share:export-work", async (_event, request: WorkShareExportRequest): Promise<WorkShareExportResult | null> => {
    const library = await listLibrary();
    const work = library.works.find((candidate) => candidate.id === request.workId);
    const defaultName = `${sanitizeShareFileName(work?.title ?? "manga-share")}.mgtshare`;
    const options = {
      title: "공유 파일 저장",
      defaultPath: defaultName,
      filters: [{ name: "Manga Gemma Share", extensions: ["mgtshare"] }]
    } satisfies Electron.SaveDialogOptions;
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return null;
    }
    return exportWorkShareToFile({
      ...request,
      outputPath: result.filePath.toLowerCase().endsWith(".mgtshare") ? result.filePath : `${result.filePath}.mgtshare`
    });
  });

  ipcMain.handle("share:preview-import", async (): Promise<WorkShareImportPreview | null> => {
    const options = {
      title: "공유 파일 가져오기",
      properties: ["openFile"],
      filters: [{ name: "Manga Gemma Share", extensions: ["mgtshare"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return previewWorkShareImport(result.filePaths[0]);
  });

  ipcMain.handle("share:import", async (_event, request: WorkShareImportRequest): Promise<WorkShareImportResult> => importWorkShare(request));

  ipcMain.handle("job:start-analysis", async (_event, request: StartAnalysisRequest): Promise<StartAnalysisResult> => {
    if (activeJob) {
      return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
    }

    const resolved = await resolvePagesForRun(request.chapterId, request.runMode, request.pageId);
    if (resolved.pages.length === 0) {
      return {
        status: "completed",
        chapter: resolved.chapter,
        warnings: []
      };
    }

    const id = randomUUID();
    const abortController = new AbortController();
    const pageIds = resolved.pages.map((page) => page.id);
    let runPaths: Awaited<ReturnType<typeof getRunPaths>> | null = null;
    await markChapterPagesRunning(request.chapterId, pageIds);
    activeJob = { id, abortController };

    const emit = (event: JobEvent) => {
      if (activeJob?.id === id) {
        activeJob.lastEvent = event;
      }
      writeLog(event.status === "failed" ? "error" : event.status === "cancelled" ? "warn" : "info", `job:${event.kind}:${event.status}`, {
        id: event.id,
        progressText: event.progressText,
        phase: event.phase,
        progressCurrent: event.progressCurrent,
        progressTotal: event.progressTotal,
        progressMode: event.progressMode,
        progressPercent: event.progressPercent,
        progressBytes: event.progressBytes,
        progressTotalBytes: event.progressTotalBytes,
        progressBytesPerSecond: event.progressBytesPerSecond,
        installLogLine: event.installLogLine,
        pageIndex: event.pageIndex,
        pageTotal: event.pageTotal,
        attempt: event.attempt,
        attemptTotal: event.attemptTotal,
        detail: event.detail
      });
      mainWindow?.webContents.send("job:event", event);
    };

    try {
      runPaths = await getRunPaths(request.chapterId, id);
      const result = await runWholePagePipeline({
        jobId: id,
        emit,
        onCleanupReady: (cleanup) => {
          if (activeJob?.id === id) {
            activeJob.cleanup = cleanup;
          }
        },
        onPageComplete: async (page) => {
          await updatePageAfterAnalysis(request.chapterId, page, [], "completed");
        },
        onPageFailed: async (page, errorMessage) => {
          await updatePageAfterAnalysis(request.chapterId, page, [errorMessage], "failed");
        },
        pages: resolved.pages,
        runPaths,
        signal: abortController.signal
      });

      if (abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      emit({
        id,
        kind: "gemma-analysis",
        status: "completed",
        progressText: "번역 작업 완료",
        phase: "done",
        progressCurrent: resolved.pages.length,
        progressTotal: resolved.pages.length,
        pageTotal: resolved.pages.length
      });

      return {
        status: "completed",
        chapter: await openChapter(request.chapterId),
        warnings: result.warnings
      };
    } catch (error) {
      const lastEvent = activeJob?.id === id ? activeJob.lastEvent : undefined;
      if (isAbortError(error) || abortController.signal.aborted) {
        await finalizeRunningPages(request.chapterId, pageIds, "idle");
        emit({
          id,
          kind: "gemma-analysis",
          status: "cancelled",
          progressText: "작업이 취소되었습니다.",
          phase: "cancelled",
          progressCurrent: lastEvent?.progressCurrent,
          progressTotal: lastEvent?.progressTotal,
          pageIndex: lastEvent?.pageIndex,
          pageTotal: lastEvent?.pageTotal,
          attempt: lastEvent?.attempt,
          attemptTotal: lastEvent?.attemptTotal
        });
        return { status: "cancelled", chapter: await openChapter(request.chapterId) };
      }

      const message = error instanceof Error ? error.message : String(error);
      await finalizeRunningPages(request.chapterId, pageIds, "failed", message);
      logError("Analysis job failed", {
        jobId: id,
        request,
        chapterId: request.chapterId,
        runMode: request.runMode,
        pageIds,
        resolvedPageCount: resolved.pages.length,
        resolvedPageNames: resolved.pages.map((page) => page.name),
        runPaths,
        lastEvent,
        error
      });
      emit({
        id,
        kind: "gemma-analysis",
        status: "failed",
        progressText: "작업 실패",
        phase: "failed",
        progressCurrent: lastEvent?.progressCurrent,
        progressTotal: lastEvent?.progressTotal,
        pageIndex: lastEvent?.pageIndex,
        pageTotal: lastEvent?.pageTotal,
        attempt: lastEvent?.attempt,
        attemptTotal: lastEvent?.attemptTotal,
        detail: message
      });
      return {
        status: "failed",
        error: message,
        chapter: await openChapter(request.chapterId)
      };
    } finally {
      if (activeJob?.id === id) {
        await runJobCleanup(activeJob, "job-finished");
        activeJob = null;
      }
    }
  });

  ipcMain.handle("job:translate-region", async (_event, request: RegionAnalysisRequest): Promise<RegionAnalysisResult> => {
    if (activeJob) {
      return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
    }

    const chapter = await openChapter(request.chapterId);
    const page = chapter.pages.find((candidate) => candidate.id === request.pageId);
    if (!page) {
      return { status: "failed", chapter, error: "선택한 페이지를 찾지 못했습니다." };
    }

    const id = randomUUID();
    const abortController = new AbortController();
    let runPaths: Awaited<ReturnType<typeof getRunPaths>> | null = null;
    activeJob = { id, abortController };

    const emit = (event: JobEvent) => {
      if (activeJob?.id === id) {
        activeJob.lastEvent = event;
      }
      writeLog(event.status === "failed" ? "error" : event.status === "cancelled" ? "warn" : "info", `job:${event.kind}:${event.status}`, {
        id: event.id,
        progressText: event.progressText,
        phase: event.phase,
        progressCurrent: event.progressCurrent,
        progressTotal: event.progressTotal,
        progressMode: event.progressMode,
        progressPercent: event.progressPercent,
        progressBytes: event.progressBytes,
        progressTotalBytes: event.progressTotalBytes,
        progressBytesPerSecond: event.progressBytesPerSecond,
        installLogLine: event.installLogLine,
        pageIndex: event.pageIndex,
        pageTotal: event.pageTotal,
        attempt: event.attempt,
        attemptTotal: event.attemptTotal,
        detail: event.detail
      });
      mainWindow?.webContents.send("job:event", event);
    };

    try {
      runPaths = await getRunPaths(request.chapterId, id);
      const { cropPage, cropRect } = await createRegionCropPage(page, request.bbox, id, runPaths.runDir);
      emit({
        id,
        kind: "gemma-analysis",
        status: "starting",
        progressText: "선택 영역 번역 준비 중",
        phase: "booting",
        progressCurrent: 0,
        progressTotal: 1,
        pageTotal: 1,
        detail: `${Math.round(cropRect.w)} x ${Math.round(cropRect.h)} px`
      });

      const result = await runWholePagePipeline({
        jobId: id,
        emit,
        onCleanupReady: (cleanup) => {
          if (activeJob?.id === id) {
            activeJob.cleanup = cleanup;
          }
        },
        pages: [cropPage],
        runPaths,
        signal: abortController.signal,
        skipOcrPrepass: true
      });

      if (abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const analyzedCrop = result.pages[0];
      const mappedBlocks = analyzedCrop ? mapRegionBlocksToPageBlocks(analyzedCrop.blocks, page, cropRect) : [];
      const latest = await openChapter(request.chapterId);
      const now = new Date().toISOString();
      const nextChapter: typeof latest = {
        ...latest,
        pages: latest.pages.map((candidate) =>
          candidate.id === request.pageId
            ? {
                ...candidate,
                blocks: [...candidate.blocks, ...mappedBlocks],
                analysisStatus: "completed",
                lastError: undefined,
                updatedAt: now
              }
            : candidate
        ),
        updatedAt: now
      };
      const saved = await saveChapterSnapshot(nextChapter);

      emit({
        id,
        kind: "gemma-analysis",
        status: "completed",
        progressText: "선택 영역 번역 완료",
        phase: "done",
        progressCurrent: 1,
        progressTotal: 1,
        pageTotal: 1,
        detail: `${mappedBlocks.length}개 블록`
      });

      return {
        status: "completed",
        chapter: saved,
        warnings: result.warnings,
        pageId: request.pageId,
        blockIds: mappedBlocks.map((block) => block.id)
      };
    } catch (error) {
      const lastEvent = activeJob?.id === id ? activeJob.lastEvent : undefined;
      if (isAbortError(error) || abortController.signal.aborted) {
        emit({
          id,
          kind: "gemma-analysis",
          status: "cancelled",
          progressText: "작업이 취소되었습니다.",
          phase: "cancelled",
          progressCurrent: lastEvent?.progressCurrent,
          progressTotal: lastEvent?.progressTotal,
          pageIndex: lastEvent?.pageIndex,
          pageTotal: lastEvent?.pageTotal,
          attempt: lastEvent?.attempt,
          attemptTotal: lastEvent?.attemptTotal
        });
        return { status: "cancelled", chapter: await openChapter(request.chapterId), pageId: request.pageId };
      }

      const message = error instanceof Error ? error.message : String(error);
      logError("Region translation job failed", {
        jobId: id,
        request,
        runPaths,
        lastEvent,
        error
      });
      emit({
        id,
        kind: "gemma-analysis",
        status: "failed",
        progressText: "작업 실패",
        phase: "failed",
        progressCurrent: lastEvent?.progressCurrent,
        progressTotal: lastEvent?.progressTotal,
        pageIndex: lastEvent?.pageIndex,
        pageTotal: lastEvent?.pageTotal,
        attempt: lastEvent?.attempt,
        attemptTotal: lastEvent?.attemptTotal,
        detail: message
      });
      return {
        status: "failed",
        error: message,
        chapter: await openChapter(request.chapterId),
        pageId: request.pageId
      };
    } finally {
      if (activeJob?.id === id) {
        await runJobCleanup(activeJob, "region-job-finished");
        activeJob = null;
      }
    }
  });

  ipcMain.handle("job:cancel", async () => {
    if (!activeJob) {
      return { cancelled: false };
    }

    const job = activeJob;
    mainWindow?.webContents.send("job:event", {
      id: job.id,
      kind: "gemma-analysis",
      status: "cancelling",
      progressText: "작업 취소 중",
      progressCurrent: job.lastEvent?.progressCurrent,
      progressTotal: job.lastEvent?.progressTotal,
      pageIndex: job.lastEvent?.pageIndex,
      pageTotal: job.lastEvent?.pageTotal,
      attempt: job.lastEvent?.attempt,
      attemptTotal: job.lastEvent?.attemptTotal
    } satisfies JobEvent);
    job.abortController.abort();
    await runJobCleanup(job, "cancel");
    return { cancelled: true };
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isZipPath(path: string): boolean {
  return extname(path).toLowerCase() === ".zip";
}

function loadSimplePageRuntime(): SimplePageRuntime {
  if (cachedSimplePageRuntime) {
    return cachedSimplePageRuntime;
  }

  cachedSimplePageRuntime = require(join(appPaths.runtimeDir, "simple-page-translate.cjs")) as SimplePageRuntime;
  return cachedSimplePageRuntime;
}

function detectSiblingMmprojPath(modelPath: string): string | null {
  const folder = dirname(modelPath);
  if (!existsSync(folder)) {
    return null;
  }

  const preferredNames = ["mmproj-BF16.gguf", "mmproj-F16.gguf", "mmproj-F32.gguf", "mmproj.gguf"];
  for (const name of preferredNames) {
    const candidate = join(folder, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const match = readdirSync(folder, { withFileTypes: true }).find(
    (entry) => entry.isFile() && /^mmproj.*\.gguf$/i.test(entry.name)
  );
  return match ? join(folder, match.name) : null;
}

function resolveSettingsLaunchMode(settings: AppSettings): ModelTestResult["launchMode"] {
  if (settings.modelProvider === "openai-codex") {
    return "openai-codex";
  }
  return settings.gemma.modelSource === "local" ? "local" : "huggingface";
}

function sanitizeShareFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned || "manga-share";
}

function isOpenAIOAuthEndpoint(server: Awaited<ReturnType<SimplePageRuntime["startServer"]>> | OpenAIOAuthEndpoint | null): server is OpenAIOAuthEndpoint {
  return Boolean(server && "provider" in server && server.provider === "openai-codex");
}

async function reserveFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("모델 테스트용 포트를 확보하지 못했습니다."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function formatModelTestError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const details = [
    error.message,
    "recentStderr" in error && typeof error.recentStderr === "string" && error.recentStderr.trim()
      ? error.recentStderr.trim()
      : null,
    "rawTextPreview" in error && typeof error.rawTextPreview === "string" && error.rawTextPreview.trim()
      ? error.rawTextPreview.trim()
      : null
  ].filter(Boolean);

  return details.join("\n\n");
}
