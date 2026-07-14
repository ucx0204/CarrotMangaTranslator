import { app, BrowserWindow, Menu } from "electron";
import { ensureWritableAppDirectories } from "./appPaths";
import { cleanupLegacyLogs } from "./appMaintenance";
import {
  registerImageProtocolHandler,
  registerImageProtocolScheme,
} from "./imageProtocol";
import { registerIpc } from "./ipc/registerIpc";
import { ActiveJobStore } from "./jobs/activeJob";
import {
  canReleaseInpaintingHistoryAfterQuitCleanup,
  finishBeforeQuitCleanup,
} from "./jobs/beforeQuitCleanup";
import { disposeCachedInpaintingEngines } from "./inpainting/inpaintingEnginePool";
import { InpaintingRevisionStore } from "./inpainting/inpaintingRevisionStore";
import { cleanupLibraryOrphans, getLibraryRoot } from "./library";
import { getLogPath, logError, logInfo, logWarn, resetAppLog } from "./logger";
import { createMainWindow } from "./mainWindow";
import { PanelWindowRegistry } from "./panelWindows";
import { initializeMainLocaleFromSettings } from "./i18n";
import {
  decodeImageThroughRuntime,
  loadSimplePageRuntime,
} from "./simplePageRuntime";

const appPaths = ensureWritableAppDirectories();
const jobs = new ActiveJobStore();
const inpaintingRevisionStore = new InpaintingRevisionStore();
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
    inpaintingRevisionStore,
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
  if (quitCleanupStarted) {
    return;
  }
  event.preventDefault();
  quitCleanupStarted = true;
  void finishAppQuitCleanup();
});

async function finishAppQuitCleanup(): Promise<void> {
  let inpaintingHistoryReleaseSafe = true;
  try {
    const job = jobs.current;
    if (job) {
      const cleanup = await finishBeforeQuitCleanup({
        job,
        jobs,
        quit: () => undefined,
        warnTimedOut: (jobId, timeoutMs) => {
          logWarn("Timed out waiting for active job cleanup during app quit", {
            jobId,
            timeoutMs,
          });
        },
      });
      inpaintingHistoryReleaseSafe =
        canReleaseInpaintingHistoryAfterQuitCleanup(job.kind, cleanup);
      if (!inpaintingHistoryReleaseSafe) {
        logWarn(
          "Skipping inpainting history release because the active job did not settle before quit",
          { jobId: job.id },
        );
      }
    }
    await disposeCachedInpaintingEngines("app-quit");
    if (inpaintingHistoryReleaseSafe) {
      await inpaintingRevisionStore.releaseAll();
    }
  } catch (error) {
    logError("Failed to clean up before app quit", error);
  } finally {
    app.quit();
  }
}

function openMainWindow(): void {
  mainWindow = createMainWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
    panelWindows.closeAll();
    void disposeCachedInpaintingEngines("main-window-closed");
  });
}
