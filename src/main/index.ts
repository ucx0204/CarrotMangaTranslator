import { app, BrowserWindow, Menu } from "electron";
import { ensureWritableAppDirectories } from "./appPaths";
import { registerIpc } from "./ipc/registerIpc";
import { ActiveJobStore } from "./jobs/activeJob";
import { cleanupLegacyLogs, cleanupLibraryOrphans, getLibraryRoot } from "./library";
import { getLogPath, logError, logInfo, resetAppLog } from "./logger";
import { createMainWindow } from "./mainWindow";
import { decodeImageThroughRuntime, loadSimplePageRuntime } from "./simplePageRuntime";

const appPaths = ensureWritableAppDirectories();
const jobs = new ActiveJobStore();
let mainWindow: BrowserWindow | null = null;

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

app.whenReady().then(async () => {
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
    loadSimplePageRuntime: () => loadSimplePageRuntime(appPaths.runtimeDir),
    decodeImage: (filePath) => decodeImageThroughRuntime(appPaths.runtimeDir, filePath)
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

app.on("before-quit", () => {
  const job = jobs.current;
  if (job) {
    job.abortController.abort();
    void jobs.runCleanup(job, "before-quit");
  }
});

function openMainWindow(): void {
  mainWindow = createMainWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
