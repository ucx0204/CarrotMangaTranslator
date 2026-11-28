import { app, BrowserWindow, dialog, shell } from "electron";
import { ipcEventContracts } from "../shared/ipcContracts";
import type { ErrorReportContext } from "../shared/errorReportTypes";
import { ErrorReportContextSchema } from "../shared/errorReportSchemas";
import { normalizeErrorReportContext } from "../shared/errorReportContext";
import { tMain, tMainCommon } from "./i18n";
import { prepareAppRelaunch } from "./appRelaunch";
import { APP_ISSUES_URL } from "../shared/appRelease";
import {
  applyRendererWindowGuards,
  loadRendererIntoWindow,
  observeRendererFailure,
  rendererWebPreferences,
  resolveRendererLoadTarget,
} from "./mainWindow";

export type ErrorReportWindowDependencies = {
  applyRendererWindowGuards: typeof applyRendererWindowGuards;
  incidentChannel: string;
  loadRendererIntoWindow: typeof loadRendererIntoWindow;
  parseContext: (context: ErrorReportContext) => ErrorReportContext;
  rendererWebPreferences: typeof rendererWebPreferences;
  resolveRendererLoadTarget: typeof resolveRendererLoadTarget;
  title: () => string;
};

const productionDependencies: ErrorReportWindowDependencies = {
  applyRendererWindowGuards,
  incidentChannel: ipcEventContracts.errorIncident.channel,
  loadRendererIntoWindow,
  parseContext: (context) =>
    ErrorReportContextSchema.parse(normalizeErrorReportContext(context)),
  rendererWebPreferences,
  resolveRendererLoadTarget,
  title: () => tMainCommon("app.title"),
};

/**
 * Owns the isolated error-report renderer window.
 *
 * Error details stay in the main process and are delivered over the typed
 * renderer event after load. The renderer URL contains only the fixed route,
 * so stack traces and local paths cannot leak into history or navigation logs.
 */
export class ErrorReportWindowRegistry {
  private window: BrowserWindow | null = null;
  private currentContext: ErrorReportContext | null = null;

  constructor(
    private readonly onFailure: (detail: string) => void,
    private readonly dependencies: ErrorReportWindowDependencies = productionDependencies,
  ) {}

  open(context: ErrorReportContext): BrowserWindow {
    this.currentContext = this.dependencies.parseContext(context);

    const existing = this.getWindow();
    if (existing) {
      this.sendCurrentContext(existing);
      if (existing.isMinimized()) {
        existing.restore();
      }
      existing.show();
      existing.focus();
      return existing;
    }

    const target = this.dependencies.resolveRendererLoadTarget();
    const window = new BrowserWindow({
      width: 720,
      height: 780,
      minWidth: 360,
      minHeight: 520,
      show: false,
      title: this.dependencies.title(),
      ...(target.windowIconPath ? { icon: target.windowIconPath } : {}),
      backgroundColor: "#101114",
      autoHideMenuBar: true,
      webPreferences: this.dependencies.rendererWebPreferences(),
    });
    this.window = window;

    const reportFailure = (detail: string) => {
      if (this.window !== window) return;
      this.onFailure(detail);
      this.closeAll();
    };
    observeRendererFailure(window, "error-report", reportFailure);
    window.setMenuBarVisibility(false);
    this.dependencies.applyRendererWindowGuards(
      window,
      target.allowedRendererUrl,
    );
    window.webContents.on("did-finish-load", () => {
      this.sendCurrentContext(window);
    });
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) {
        window.show();
        window.focus();
      }
    });
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
        this.currentContext = null;
      }
    });

    this.dependencies.loadRendererIntoWindow(
      window,
      target,
      "error-report",
      reportFailure,
    );
    return window;
  }

  isTrustedSender(webContentsId: number): boolean {
    const window = this.getWindow();
    return window?.webContents.id === webContentsId;
  }

  getWindow(): BrowserWindow | null {
    if (!this.window || this.window.isDestroyed()) {
      return null;
    }
    return this.window;
  }

  close(): void {
    this.getWindow()?.close();
  }

  closeAll(): void {
    const window = this.getWindow();
    if (window) {
      window.destroy();
    }
    this.window = null;
    this.currentContext = null;
  }

  private sendCurrentContext(window: BrowserWindow): void {
    if (
      !this.currentContext ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) {
      return;
    }
    window.webContents.send(
      this.dependencies.incidentChannel,
      this.currentContext,
    );
  }
}

let recoveryDialogOpen = false;

/** This dialog must work even if every Chromium window fails to paint. */
export async function showRendererRecoveryDialog(
  detail: string,
  state: {
    stopping: () => boolean;
    canReturn: () => boolean;
    logDirectory: string;
    reportError: (message: string, error: unknown) => void;
  },
): Promise<void> {
  if (recoveryDialogOpen) return;
  recoveryDialogOpen = true;
  let actionError: string | null = "";
  try {
    while (actionError !== null && !state.stopping()) {
      const canReturn = state.canReturn();
      const { response } = await dialog.showMessageBox({
        type: "error",
        title: tMain("errorReport.loadFailureTitle"),
        message: tMain("errorReport.recoveryMessage"),
        detail: [detail, actionError].filter(Boolean).join("\n\n"),
        buttons: [
          tMain("errorReport.restartRecovery"),
          tMain("errorReport.openLogs"),
          tMain("errorReport.openIssues"),
          tMain(canReturn ? "errorReport.close" : "errorReport.exit"),
        ],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
      });
      if (state.stopping()) return;
      try {
        actionError = await handleRecoveryChoice(
          response,
          canReturn,
          state.canReturn,
          state.logDirectory,
        );
      } catch (error) {
        actionError = error instanceof Error ? error.message : String(error);
        state.reportError("Renderer recovery action failed", error);
      }
    }
  } catch (error) {
    state.reportError("Could not show renderer recovery dialog", error);
    try {
      dialog.showErrorBox(tMain("errorReport.loadFailureTitle"), detail);
    } catch (fallbackError) {
      state.reportError("Could not show the native error box", fallbackError);
    } finally {
      if (!state.canReturn() && !state.stopping()) app.quit();
    }
  } finally {
    recoveryDialogOpen = false;
  }
}

async function handleRecoveryChoice(
  response: number,
  offeredReturn: boolean,
  canReturn: () => boolean,
  logDirectory: string,
): Promise<string | null> {
  switch (response) {
    case 0:
      await prepareAppRelaunch(true);
      app.quit();
      return null;
    case 1:
      return shell.openPath(logDirectory);
    case 2:
      await shell.openExternal(APP_ISSUES_URL);
      return "";
    default:
      if (offeredReturn && !canReturn()) return "";
      if (!offeredReturn) app.quit();
      return null;
  }
}
