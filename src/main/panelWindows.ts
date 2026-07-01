import { BrowserWindow, screen } from "electron";
import { ipcEventContracts } from "../shared/ipcContracts";
import type { PanelId, PanelSyncState } from "../shared/panelBridgeTypes";
import {
  applyRendererWindowGuards,
  loadRendererIntoWindow,
  rendererWebPreferences,
  resolveRendererLoadTarget,
  type RendererLoadTarget,
} from "./mainWindow";
import {
  PanelWindowBoundsStore,
  type PanelWindowBounds,
} from "./panelWindowBounds";

const PANEL_WINDOW_TITLES: Record<PanelId, string> = {
  editor: "블록 편집",
};

/**
 * Owns the popped-out panel BrowserWindows and the bridge fan-out. The main
 * window remains the single source of truth: it publishes {@link PanelSyncState}
 * here, which is cached and forwarded to every open panel window (including ones
 * that open later, via the cached snapshot on load).
 */
export class PanelWindowRegistry {
  private readonly windows = new Map<PanelId, BrowserWindow>();
  private lastState: PanelSyncState | null = null;
  private readonly boundsStore: PanelWindowBoundsStore;

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    dataRoot: string,
  ) {
    this.boundsStore = new PanelWindowBoundsStore(dataRoot);
  }

  open(panelId: PanelId): boolean {
    const existing = this.windows.get(panelId);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return true;
    }
    const target = resolveRendererLoadTarget();
    const window = createPanelBrowserWindow(
      panelId,
      target,
      resolveVisibleBounds(this.boundsStore.get(panelId)),
    );
    this.windows.set(panelId, window);

    window.webContents.on("did-finish-load", () => {
      this.sendStateTo(window);
    });
    window.on("close", () => {
      if (!window.isDestroyed()) {
        this.boundsStore.set(panelId, window.getBounds());
      }
    });
    window.on("closed", () => {
      if (this.windows.get(panelId) === window) {
        this.windows.delete(panelId);
        this.notifyWindowsChanged();
      }
    });

    loadRendererIntoWindow(window, target, `panel=${panelId}`);
    this.notifyWindowsChanged();
    return true;
  }

  close(panelId: PanelId): boolean {
    const window = this.windows.get(panelId);
    if (!window || window.isDestroyed()) {
      return false;
    }
    window.close();
    return true;
  }

  publishState(state: PanelSyncState): void {
    this.lastState = state;
    for (const window of this.windows.values()) {
      this.sendStateTo(window);
    }
  }

  getOpenPanelIds(): PanelId[] {
    return [...this.windows.entries()]
      .filter(([, window]) => !window.isDestroyed())
      .map(([panelId]) => panelId);
  }

  getLastState(): PanelSyncState | null {
    return this.lastState;
  }

  isPanelSender(webContentsId: number): boolean {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed() && window.webContents.id === webContentsId) {
        return true;
      }
    }
    return false;
  }

  closeAll(): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    }
    this.windows.clear();
  }

  private sendStateTo(window: BrowserWindow): void {
    if (!this.lastState || window.isDestroyed()) {
      return;
    }
    window.webContents.send(
      ipcEventContracts.panelState.channel,
      ipcEventContracts.panelState.payload.parse(this.lastState),
    );
  }

  private notifyWindowsChanged(): void {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send(
      ipcEventContracts.panelWindowsChanged.channel,
      ipcEventContracts.panelWindowsChanged.payload.parse(
        this.getOpenPanelIds(),
      ),
    );
  }
}

function createPanelBrowserWindow(
  panelId: PanelId,
  target: RendererLoadTarget,
  savedBounds: PanelWindowBounds | undefined,
): BrowserWindow {
  const window = new BrowserWindow({
    width: savedBounds?.width ?? 520,
    height: savedBounds?.height ?? 760,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    minWidth: 360,
    minHeight: 320,
    ...(target.windowIconPath ? { icon: target.windowIconPath } : {}),
    title: PANEL_WINDOW_TITLES[panelId],
    backgroundColor: "#101114",
    autoHideMenuBar: true,
    webPreferences: rendererWebPreferences(),
  });
  window.setMenuBarVisibility(false);
  applyRendererWindowGuards(window, target.allowedRendererUrl);
  return window;
}

// Drops a saved position that no longer lands on any connected display (e.g. a
// monitor was unplugged), keeping the size so the window is still reachable.
function resolveVisibleBounds(
  bounds: PanelWindowBounds | undefined,
): PanelWindowBounds | undefined {
  if (!bounds) {
    return undefined;
  }
  const onScreen = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
  return onScreen ? bounds : { ...bounds, x: 0, y: 0 };
}
