import { app, BrowserWindow, Menu } from "electron";
import { ensureWritableAppDirectories } from "./appPaths";
import { cleanupLegacyLogs } from "./appMaintenance";
import {
  registerImageProtocolHandler,
  registerImageProtocolScheme,
} from "./imageProtocol";
import { registerIpc } from "./ipc/registerIpc";
import type { ActiveJob } from "./jobs/activeJob";
import { ActiveJobStore } from "./jobs/activeJob";
import { cleanupLibraryOrphans, getLibraryRoot } from "./library";
import { getLogPath, logError, logInfo, logWarn, resetAppLog } from "./logger";
import { createMainWindow } from "./mainWindow";
import { PanelWindowRegistry } from "./panelWindows";
import { initializeMainLocaleFromSettings } from "./i18n";
import {
  decodeImageThroughRuntime,
  loadSimplePageRuntime,
} from "./simplePageRuntime";

const BEFORE_QUIT_CLEANUP_TIMEOUT_MS = 5000;

const appPaths = ensureWritableAppDirectories();
const jobs = new ActiveJobStore();
let mainWindow: BrowserWindow | null = null;
const panelWindows = new PanelWindowRegistry(
  () => mainWindow,
  appPaths.dataRoot,
);
let quitCleanupStarted = false;

registerImageProtocolScheme();
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
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled rejection", reason);
});

app.whenReady().then(async () => {
  process.env.MANGA_TRANSLATOR_UI_LOCALE ??= app.getLocale();
  await initializeMainLocaleFromSettings(
    appPaths.settingsPath,
    process.env.MANGA_TRANSLATOR_UI_LOCALE,
  );
  registerImageProtocolHandler();
  await cleanupLegacyLogs();
  const cleanupResult = await cleanupLibraryOrphans();
  if (
    cleanupResult.missingWorkReferencesRemoved > 0 ||
    cleanupResult.missingChapterReferencesRemoved > 0 ||
    cleanupResult.workDirsRemoved > 0 ||
    cleanupResult.chapterDirsRemoved > 0
  ) {
    logInfo("Library orphan cleanup finished", cleanupResult);
  }
  Menu.setApplicationMenu(null);
  registerIpc({
    appPaths,
    jobs,
    getMainWindow: () => mainWindow,
    panelWindows,
    loadSimplePageRuntime: () => loadSimplePageRuntime(appPaths.runtimeDir),
    decodeImage: (filePath) =>
      decodeImageThroughRuntime(appPaths.runtimeDir, filePath),
  });
  openMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  const job = jobs.current;
  if (!job || quitCleanupStarted) {
    return;
  }
  event.preventDefault();
  quitCleanupStarted = true;
  job.abortController.abort();
  void finishBeforeQuitCleanup(job);
});

function openMainWindow(): void {
  mainWindow = createMainWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
    panelWindows.closeAll();
  });
}

async function finishBeforeQuitCleanup(job: ActiveJob): Promise<void> {
  const timedOut = await Promise.race([
    jobs.runCleanup(job, "before-quit").then(() => false),
    delay(BEFORE_QUIT_CLEANUP_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) {
    logWarn("Timed out waiting for active job cleanup during app quit", {
      jobId: job.id,
      timeoutMs: BEFORE_QUIT_CLEANUP_TIMEOUT_MS,
    });
  }
  jobs.clearIfCurrent(job.id);
  app.quit();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
