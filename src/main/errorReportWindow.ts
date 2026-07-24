import { BrowserWindow } from "electron";
import { ipcEventContracts } from "../shared/ipcContracts";
import type { ErrorReportContext } from "../shared/errorReportTypes";
import { ErrorReportContextSchema } from "../shared/errorReportSchemas";
import { tMainCommon } from "./i18n";
import {
  applyRendererWindowGuards,
  loadRendererIntoWindow,
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
  parseContext: (context) => ErrorReportContextSchema.parse(context),
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

    this.dependencies.loadRendererIntoWindow(window, target, "error-report");
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
