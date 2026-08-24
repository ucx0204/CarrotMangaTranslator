/* eslint-disable max-lines -- startup recovery, IPC publication, window creation, and quit ordering stay co-located for auditability */
import { app, BrowserWindow, dialog, shell } from "electron";
import { ensureWritableAppDirectories, getAppPaths } from "./appPaths";
import { AppActivityGate } from "./appActivityGate";
import { cleanupLegacyLogs } from "./appMaintenance";
import { AppOperationRegistry } from "./appOperationRegistry";
import {
  beginBoundedAppQuit,
  type AppQuitCleanupProgress,
} from "./appQuitCoordinator";
import {
  runAppQuitCleanup,
  type AppTerminalCleanupReason,
} from "./appQuitCleanup";
import {
  FatalMainProcessIncidentCoordinator,
  type FatalMainProcessIncidentRuntime,
  type FatalMainProcessIncidentSource,
} from "./fatalMainProcessIncident";
import {
  registerImageProtocolHandler,
  registerImageProtocolScheme,
} from "./imageProtocol";
import {
  createImportRuntimeResources,
  registerImportProtocolSchemes,
  registerIpc,
} from "./ipc/registerIpc";
import { ActiveJobStore } from "./jobs/activeJob";
import { disposeCachedInpaintingEngines } from "./inpainting/inpaintingEnginePool";
import { InpaintingRevisionStore } from "./inpainting/inpaintingRevisionStore";
import {
  cleanupLibraryOrphans,
  getLibraryRoot,
  libraryMutationCoordinator,
  recoverLegacyShareImportTrash,
  recoverLibraryTransactions,
} from "./library";
import {
  getLogDirectory,
  getLogPath,
  logError,
  logInfo,
  logWarn,
  resetAppLog,
} from "./logger";
import { createMainWindow } from "./mainWindow";
import { PanelWindowRegistry } from "./panelWindows";
import { ErrorReportWindowRegistry } from "./errorReportWindow";
import { initializeMainLocaleFromSettings, tMain } from "./i18n";
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
import { assertDataRootInstanceLockHeld } from "./dataRootInstanceLockState";
import { focusExistingMainWindow } from "./singleInstanceWindow";
import { runMainWindowCloseCleanup } from "./mainWindowCloseCleanup";
import { MainWindowSessionLifecycle } from "./mainWindowSessionLifecycle";
import { createLinkedWorkspaceRuntime } from "./linkedWorkspace/linkedWorkspaceRuntime";

const resolvedAppPaths = getAppPaths();
assertDataRootInstanceLockHeld(resolvedAppPaths.dataRoot);
const appPaths = ensureWritableAppDirectories();
const appActivityGate = new AppActivityGate();
const jobs = new ActiveJobStore(undefined, appActivityGate);
const operations = new AppOperationRegistry(appActivityGate);
const importRuntime = createImportRuntimeResources({
  dataRoot: appPaths.dataRoot,
  reportError: logError,
});
const inpaintingRevisionStore = new InpaintingRevisionStore();
let mainWindow: BrowserWindow | null = null;
const linkedWorkspaceRuntime = createLinkedWorkspaceRuntime({
  dataRoot: appPaths.dataRoot,
  jobs,
  decodeImage: (filePath, signal) =>
    decodeImageThroughRuntime(appPaths.runtimeDir, filePath, signal),
  getMainWindow: () => mainWindow,
  reportError: logError,
});
const linkedWorkspaceSync = linkedWorkspaceRuntime.service;
let removeLinkedWorkspaceNotifier: (() => void) | null = null;
const panelWindows = new PanelWindowRegistry(
  () => mainWindow,
  appPaths.dataRoot,
);
const errorReportWindows = new ErrorReportWindowRegistry();
const fatalCoordinator = new FatalMainProcessIncidentCoordinator();
const mainWindowSessionLifecycle = new MainWindowSessionLifecycle({
  suspendActivities: () => appActivityGate.suspendNewActivities(),
  suspendMutations: () => libraryMutationCoordinator.suspendNewMutations(),
  runCleanup: async () => {
    try {
      await runMainWindowCloseCleanup({
        jobs,
        operations,
        waitForLibraryMutations: () => libraryMutationCoordinator.waitForIdle(),
        disposeInpainting: () =>
          disposeCachedInpaintingEngines("main-window-closed"),
        disposeTranslation: () =>
          disposeTranslationRuntimeResources("main-window-closed"),
        logError,
        logWarn,
      });
    } finally {
      await cleanupTransientImportResources("main-window-closed");
    }
  },
  openWindow: () => openMainWindowNow(),
  runtime: {
    platform: process.platform,
    now: () => Date.now(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    clearScheduled: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    forceExit: (code) => app.exit(code),
    emergencyExit: (code) => process.exit(code),
    reportCleanupFailure: (error) =>
      logError("Main-window close cleanup failed", error),
    reportForcedExit: (detail) =>
      logError(
        "Main-window close cleanup could not finish safely; forcing process exit",
        detail,
      ),
  },
});
let quitCleanupStarted = false;
let rendererLoadFailureDialogOpen = false;
let cancelStartupMaintenance: (() => void) | null = null;
let mainStartupCompleted = false;
let secondInstanceFocusPending = false;
let terminalCleanupPromise: Promise<void> | null = null;

registerImageProtocolScheme();
registerImportProtocolSchemes();
resetAppLog();

app.on(
  "second-instance",
  (_event, _argv, _workingDirectory, additionalData) => {
    if (fatalCoordinator.isHandling || quitCleanupStarted) {
      return;
    }
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
  handleFatalMainProcessIncident(
    "uncaught-exception",
    "Uncaught exception",
    error,
  );
});

process.on("unhandledRejection", (reason) => {
  handleFatalMainProcessIncident(
    "unhandled-rejection",
    "Unhandled promise rejection",
    reason,
  );
});

void app
  .whenReady()
  .then(async () => {
    process.env.MANGA_TRANSLATOR_UI_LOCALE ??= app.getLocale();
    await initializeMainLocaleFromSettings(
      appPaths.settingsPath,
      process.env.MANGA_TRANSLATOR_UI_LOCALE,
    );
    const transactionRecovery = await recoverLibraryTransactions();
    if (
      transactionRecovery.creatingRemoved > 0 ||
      transactionRecovery.activeRolledBack > 0 ||
      transactionRecovery.committedCleaned > 0 ||
      transactionRecovery.committedCleanupWarnings > 0
    ) {
      logInfo("Library transaction recovery finished", transactionRecovery);
    }
    const legacyTrashRecovery = await recoverLegacyShareImportTrash();
    if (
      legacyTrashRecovery.chaptersRestored > 0 ||
      legacyTrashRecovery.chaptersDiscarded > 0
    ) {
      logInfo(
        "Legacy share import trash recovery finished",
        legacyTrashRecovery,
      );
    }
    if (fatalCoordinator.isHandling) {
      return;
    }
    registerImageProtocolHandler();
    await importRuntime.initialize();
    await linkedWorkspaceSync.initialize();
    removeLinkedWorkspaceNotifier =
      linkedWorkspaceRuntime.installSaveNotifier();
    if (await runMacPackageSmokeExit(appPaths)) {
      return;
    }
    installNativeApplicationMenu();
    registerIpc({
      appPaths,
      jobs,
      operations,
      getMainWindow: () => mainWindow,
      panelWindows,
      errorReportWindows,
      loadSimplePageRuntime: () => loadSimplePageRuntime(appPaths.runtimeDir),
      decodeImage: (filePath, signal) =>
        decodeImageThroughRuntime(appPaths.runtimeDir, filePath, signal),
      inpaintingRevisionStore,
      webImportManager: importRuntime.webImportManager,
      linkedWorkspaceSync,
      reportError: logError,
    });
    reactivateDock();
    openMainWindowNow();
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
      if (fatalCoordinator.isHandling || quitCleanupStarted) {
        return;
      }
      reactivateDock();
      requestMainWindowOpen();
    });
  })
  .catch((error) => {
    if (fatalCoordinator.isHandling) {
      return;
    }
    logError("Application startup failed", error);
    const normalized = normalizeIncidentReason(error);
    void showStartupFailureDialog(normalized.stack ?? normalized.message);
  });

app.on("window-all-closed", () => {
  if (fatalCoordinator.isHandling) {
    return;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function closeTerminalIntake(): void {
  try {
    appActivityGate.closeToNewActivities();
  } finally {
    try {
      libraryMutationCoordinator.closeToNewMutations();
    } finally {
      mainWindowSessionLifecycle.enterTerminalMode();
    }
  }
}

app.on("before-quit", (event) => {
  if (fatalCoordinator.isHandling) {
    event.preventDefault();
    return;
  }
  if (quitCleanupStarted) {
    return;
  }
  event.preventDefault();
  quitCleanupStarted = true;
  closeTerminalIntake();

  const attempt = beginBoundedAppQuit({
    runCleanup: (updateProgress) =>
      getOrStartTerminalCleanup("app-quit", updateProgress),
    runtime: {
      now: () => Date.now(),
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      gracefulQuit: () => app.quit(),
      forceExit: (code) => app.exit(code),
      reportCleanupFailure: (error, progress) => {
        logError("Failed to clean up before app quit", {
          ...progress,
          error,
        });
      },
      reportForcedExit: (detail) => {
        logError(
          "App quit hard deadline reached; forcing process exit",
          detail,
        );
      },
    },
  });

  void attempt.completion;
});

function handleFatalMainProcessIncident(
  source: FatalMainProcessIncidentSource,
  summary: string,
  reason: unknown,
): void {
  const attempt = fatalCoordinator.begin({
    source,
    reason,
    closeIntake: closeTerminalIntake,
    notifyIncident: () => {
      logError(summary, reason);
      safelyNotifyMainProcessIncident(summary, reason);
    },
    isolateNormalWindows,
    runCleanup: () => getOrStartTerminalCleanup("fatal-incident"),
    runtime: createFatalIncidentRuntime(),
  });
  void attempt.completion;
}

function isolateNormalWindows(): void {
  panelWindows.closeAll();
  const window = mainWindow;
  if (window && !window.isDestroyed()) {
    window.destroy();
  }
}

function createFatalIncidentRuntime(): FatalMainProcessIncidentRuntime {
  return {
    now: () => Date.now(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    clearScheduled: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    forceExit: (code) => app.exit(code),
    emergencyExit: (code) => process.exit(code),
    reportCleanupFailure: (error) =>
      logError("Fatal main-process cleanup failed", error),
    reportForcedExit: (detail) =>
      logError("Fatal main-process incident is forcing process exit", detail),
    reportSecondaryIncident: (nextSource, nextReason) =>
      console.error(
        "A secondary fatal main-process incident occurred during shutdown",
        nextSource,
        nextReason,
      ),
  };
}

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

function getOrStartTerminalCleanup(
  reason: AppTerminalCleanupReason,
  updateProgress: (progress: AppQuitCleanupProgress) => void = () => {},
): Promise<void> {
  terminalCleanupPromise ??= finishTerminalCleanup(reason, updateProgress);
  return terminalCleanupPromise;
}

async function finishTerminalCleanup(
  reason: AppTerminalCleanupReason,
  updateProgress: (progress: AppQuitCleanupProgress) => void,
): Promise<void> {
  await mainWindowSessionLifecycle.waitForCleanup();
  try {
    removeLinkedWorkspaceNotifier?.();
    removeLinkedWorkspaceNotifier = null;
    await linkedWorkspaceSync.dispose();
    await runAppQuitCleanup({
      jobs,
      operations,
      cancelStartupMaintenance: () => {
        try {
          cancelStartupMaintenance?.();
        } finally {
          cancelStartupMaintenance = null;
        }
      },
      disposeInpainting: () => disposeCachedInpaintingEngines(reason),
      disposeTranslation: () => disposeTranslationRuntimeResources(reason),
      waitForLibraryMutations: () => libraryMutationCoordinator.waitForIdle(),
      releaseInpaintingHistory: () => inpaintingRevisionStore.releaseAll(),
      updateProgress,
      logError,
      logWarn,
      cleanupReason: reason,
    });
  } finally {
    await cleanupTransientImportResources(reason);
  }
}

async function cleanupTransientImportResources(reason: string): Promise<void> {
  try {
    await importRuntime.dispose();
  } catch (error) {
    logError("Transient import cleanup failed", { reason, error });
    throw error;
  }
}

function openMainWindowNow(): void {
  if (
    quitCleanupStarted ||
    fatalCoordinator.isHandling ||
    focusExistingMainWindow(mainWindow)
  ) {
    return;
  }
  mainWindow = createMainWindow({
    onRendererIncident: (context) => {
      if (!quitCleanupStarted && !fatalCoordinator.isHandling) {
        openIsolatedErrorReport(context);
      }
    },
    onRendererLoadFailure: (failure) => {
      if (!quitCleanupStarted && !fatalCoordinator.isHandling) {
        void showRendererLoadFailureDialog(failure);
      }
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    panelWindows.closeAll();
    if (quitCleanupStarted || fatalCoordinator.isHandling) {
      return;
    }
    mainWindowSessionLifecycle.handleMainWindowClosed();
  });
}

function requestMainWindowOpen(): void {
  if (quitCleanupStarted || fatalCoordinator.isHandling) {
    return;
  }
  mainWindowSessionLifecycle.requestWindowOpen();
}

function restoreOrCreateMainWindowAfterSecondInstance(): void {
  if (
    !mainStartupCompleted ||
    quitCleanupStarted ||
    fatalCoordinator.isHandling
  ) {
    return;
  }
  secondInstanceFocusPending = false;
  requestMainWindowOpen();
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
      await shell.openPath(getLogDirectory());
    } else {
      app.quit();
    }
  } catch (error) {
    logError("Failed to show renderer load failure dialog", error);
  } finally {
    rendererLoadFailureDialogOpen = false;
  }
}
