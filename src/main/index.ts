import { app, BrowserWindow, dialog, shell } from "electron";
import { dirname } from "node:path";
import { ensureWritableAppDirectories, getAppPaths } from "./appPaths";
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
import { ErrorReportWindowRegistry } from "./errorReportWindow";
import { initializeMainLocaleFromSettings } from "./i18n";
import { tMain } from "./i18n";
import { ipcEventContracts } from "../shared/ipcContracts";
import type { ErrorReportContext } from "../shared/errorReportTypes";
import { APP_ISSUES_URL } from "../shared/appRelease";
import {
  decodeImageThroughRuntime,
  loadSimplePageRuntime,
} from "./simplePageRuntime";
import {
  installNativeApplicationMenu,
  reactivateDock,
  showMacAlphaFirstRunNotice,
} from "./macIntegration";
import { runMacPackageSmokeExit } from "./macPackageSmoke";
import { scheduleStartupMaintenance } from "./startupMaintenance";
import { disposeTranslationRuntimeResources } from "./translationRuntime";
import {
  assertDataRootInstanceLockHeld,
  releaseDataRootInstanceLockLease,
} from "./dataRootInstanceLockState";
import { focusExistingMainWindow } from "./singleInstanceWindow";

const resolvedAppPaths = getAppPaths();
assertDataRootInstanceLockHeld(resolvedAppPaths.dataRoot);
const appPaths = ensureWritableAppDirectories();
const jobs = new ActiveJobStore();
const inpaintingRevisionStore = new InpaintingRevisionStore();
let mainWindow: BrowserWindow | null = null;
const panelWindows = new PanelWindowRegistry(
  () => mainWindow,
  appPaths.dataRoot,
);
const errorReportWindows = new ErrorReportWindowRegistry();
let quitCleanupStarted = false;
let rendererLoadFailureDialogOpen = false;
let cancelStartupMaintenance: (() => void) | null = null;
let mainStartupCompleted = false;
let secondInstanceFocusPending = false;

registerImageProtocolScheme();
resetAppLog();

app.on(
  "second-instance",
  (_event, _argv, _workingDirectory, additionalData) => {
    secondInstanceFocusPending = true;
    const sanitizedData = sanitizeSecondInstanceData(additionalData);
    logInfo("Secondary application instance redirected", {
      additionalData: sanitizedData,
    });
    if (
      sanitizedData.schemaVersion === 1 &&
      sanitizedData.dataRoot &&
      sanitizedData.dataRoot !== appPaths.dataRoot
    ) {
      logWarn("Secondary instance reported a different data root", {
        currentDataRoot: appPaths.dataRoot,
        secondaryDataRoot: sanitizedData.dataRoot,
      });
    }
    if (mainStartupCompleted) {
      restoreOrCreateMainWindowAfterSecondInstance();
    }
  },
);

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
  safelyNotifyMainProcessIncident("Uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled rejection", reason);
  safelyNotifyMainProcessIncident("Unhandled promise rejection", reason);
});

void app
  .whenReady()
  .then(async () => {
    process.env.MANGA_TRANSLATOR_UI_LOCALE ??= app.getLocale();
    await initializeMainLocaleFromSettings(
      appPaths.settingsPath,
      process.env.MANGA_TRANSLATOR_UI_LOCALE,
    );
    registerImageProtocolHandler();
    if (await runMacPackageSmokeExit(appPaths)) {
      return;
    }
    installNativeApplicationMenu();
    registerIpc({
      appPaths,
      jobs,
      getMainWindow: () => mainWindow,
      panelWindows,
      errorReportWindows,
      loadSimplePageRuntime: () => loadSimplePageRuntime(appPaths.runtimeDir),
      decodeImage: (filePath, signal) =>
        decodeImageThroughRuntime(appPaths.runtimeDir, filePath, signal),
      inpaintingRevisionStore,
    });
    reactivateDock();
    openMainWindow();
    mainStartupCompleted = true;
    if (secondInstanceFocusPending) {
      restoreOrCreateMainWindowAfterSecondInstance();
    }
    cancelStartupMaintenance = scheduleStartupMaintenance({
      isBusy: () => jobs.hasActive,
      run: runStartupMaintenance,
      reportError: (error) =>
        logError("Deferred startup maintenance failed", error),
    });
    void showMacAlphaFirstRunNotice(appPaths.dataRoot, mainWindow, logWarn);

    app.on("activate", () => {
      reactivateDock();
      showOrCreateMainWindow();
    });
  })
  .catch((error) => {
    logError("Application startup failed", error);
    const normalized = normalizeIncidentReason(error);
    void showStartupFailureDialog(normalized.stack ?? normalized.message);
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
  cancelStartupMaintenance?.();
  cancelStartupMaintenance = null;
  void finishAppQuitCleanup();
});

async function runStartupMaintenance(): Promise<void> {
  await cleanupLegacyLogs();
  const cleanupResult = await cleanupLibraryOrphans();
  if (
    cleanupResult.missingWorkReferencesRemoved === 0 &&
    cleanupResult.missingChapterReferencesRemoved === 0 &&
    cleanupResult.workDirsRemoved === 0 &&
    cleanupResult.chapterDirsRemoved === 0
  ) {
    return;
  }
  logInfo("Library orphan cleanup finished", cleanupResult);
}

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
    await Promise.all([
      disposeCachedInpaintingEngines("app-quit"),
      disposeTranslationRuntimeResources("app-quit"),
    ]);
    if (inpaintingHistoryReleaseSafe) {
      await inpaintingRevisionStore.releaseAll();
    }
  } catch (error) {
    logError("Failed to clean up before app quit", error);
  } finally {
    try {
      releaseDataRootInstanceLockLease();
    } catch (error) {
      logError("Failed to release data-root instance lock", error);
    }
    app.quit();
  }
}

function openMainWindow(): void {
  if (focusExistingMainWindow(mainWindow)) {
    return;
  }
  mainWindow = createMainWindow({
    onRendererIncident: (context) => {
      if (!quitCleanupStarted) {
        openIsolatedErrorReport(context);
      }
    },
    onRendererLoadFailure: (failure) => {
      if (!quitCleanupStarted) {
        void showRendererLoadFailureDialog(failure);
      }
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    panelWindows.closeAll();
    void Promise.all([
      disposeCachedInpaintingEngines("main-window-closed"),
      disposeTranslationRuntimeResources("main-window-closed"),
    ]);
  });
}

function showOrCreateMainWindow(): void {
  if (quitCleanupStarted || focusExistingMainWindow(mainWindow)) {
    return;
  }
  openMainWindow();
}

function restoreOrCreateMainWindowAfterSecondInstance(): void {
  if (!mainStartupCompleted || quitCleanupStarted) {
    return;
  }
  secondInstanceFocusPending = false;
  showOrCreateMainWindow();
}

function sanitizeSecondInstanceData(value: unknown): {
  schemaVersion: 1 | null;
  dataRoot: string | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { schemaVersion: null, dataRoot: null };
  }
  const candidate = value as Record<string, unknown>;
  return {
    schemaVersion: candidate.schemaVersion === 1 ? 1 : null,
    dataRoot:
      typeof candidate.dataRoot === "string" &&
      candidate.dataRoot.length <= 4096
        ? candidate.dataRoot
        : null,
  };
}

function notifyMainProcessIncident(summary: string, reason: unknown): void {
  const normalized = normalizeIncidentReason(reason);
  const context: ErrorReportContext = {
    source: "main-process",
    summary,
    message: normalized.message,
    ...(normalized.stack ? { stack: normalized.stack } : {}),
  };
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    try {
      mainWindow.webContents.send(
        ipcEventContracts.errorIncident.channel,
        ipcEventContracts.errorIncident.payload.parse(context),
      );
      return;
    } catch (error) {
      logWarn("Failed to notify the main renderer about an error", error);
    }
  }
  if (app.isReady()) {
    openIsolatedErrorReport(context);
  }
}

function safelyNotifyMainProcessIncident(
  summary: string,
  reason: unknown,
): void {
  try {
    notifyMainProcessIncident(summary, reason);
  } catch (error) {
    console.error("Failed to prepare main process error report", error);
  }
}

function openIsolatedErrorReport(context: ErrorReportContext): void {
  try {
    errorReportWindows.open(context);
  } catch (error) {
    logError("Failed to open the isolated error report window", error);
    const normalized = normalizeIncidentReason(error);
    void showStartupFailureDialog(normalized.stack ?? normalized.message);
  }
}

function normalizeIncidentReason(reason: unknown): {
  message: string;
  stack?: string;
} {
  if (reason instanceof Error) {
    return {
      message: reason.message || reason.name,
      ...(reason.stack ? { stack: reason.stack } : {}),
    };
  }
  if (typeof reason === "string") {
    return { message: reason };
  }
  try {
    return { message: JSON.stringify(reason) };
  } catch (_error) {
    return { message: String(reason) };
  }
}

async function showRendererLoadFailureDialog({
  errorCode,
  errorDescription,
  validatedURL,
}: {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
}): Promise<void> {
  if (rendererLoadFailureDialogOpen) {
    return;
  }
  return showStartupFailureDialog(
    `${errorDescription} (${errorCode})\n${validatedURL}`,
  );
}

async function showStartupFailureDialog(detail: string): Promise<void> {
  if (rendererLoadFailureDialogOpen) {
    return;
  }
  rendererLoadFailureDialogOpen = true;
  try {
    const result = await dialog.showMessageBox({
      type: "error",
      title: tMain("errorReport.loadFailureTitle"),
      message: tMain("errorReport.loadFailureMessage"),
      detail,
      buttons: [
        tMain("errorReport.openIssues"),
        tMain("errorReport.openLogs"),
        tMain("errorReport.exit"),
      ],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (result.response === 0) {
      await shell.openExternal(APP_ISSUES_URL);
    } else if (result.response === 1) {
      await shell.openPath(dirname(getLogPath()));
    } else {
      app.quit();
    }
  } catch (error) {
    logError("Failed to show renderer load failure dialog", error);
  } finally {
    rendererLoadFailureDialogOpen = false;
  }
}
