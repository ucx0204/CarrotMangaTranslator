import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorReportContext } from "../src/shared/errorReportTypes";

type Listener = (...args: unknown[]) => void;
type WindowOptions = {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  show?: boolean;
  webPreferences?: Record<string, unknown>;
};

const applyRendererWindowGuards = vi.fn();
const loadRendererIntoWindow = vi.fn();
const parseErrorIncident = vi.fn((value: ErrorReportContext) => value);
const rendererWebPreferences = vi.fn(() => ({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
}));
const resolveRendererLoadTarget = vi.fn(() => ({
  devRendererUrl: null,
  productionRendererPath: "C:\\app\\renderer\\index.html",
  allowedRendererUrl: "file:///C:/app/renderer/index.html",
  windowIconPath: null,
}));

let nextWebContentsId = 40;
let latestWindow: FakeBrowserWindow | null = null;

class FakeBrowserWindow {
  readonly options: WindowOptions;
  readonly listeners = new Map<string, Listener>();
  readonly onceListeners = new Map<string, Listener>();
  readonly setMenuBarVisibility = vi.fn();
  readonly show = vi.fn();
  readonly focus = vi.fn();
  readonly restore = vi.fn();
  readonly close = vi.fn(() => {
    this.emit("closed");
  });
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("closed");
  });
  readonly webContents = {
    id: nextWebContentsId++,
    destroyed: false,
    on: vi.fn((event: string, listener: Listener) => {
      this.listeners.set(`webContents:${event}`, listener);
    }),
    isDestroyed: vi.fn(() => this.webContents.destroyed),
    send: vi.fn(),
  };
  destroyed = false;
  minimized = false;

  constructor(options: WindowOptions) {
    this.options = options;
    latestWindow = this;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, listener);
    return this;
  }

  once(event: string, listener: Listener): this {
    this.onceListeners.set(event, listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.(...args);
    const onceListener = this.onceListeners.get(event);
    if (onceListener) {
      this.onceListeners.delete(event);
      onceListener(...args);
    }
  }

  emitWebContents(event: string, ...args: unknown[]): void {
    this.listeners.get(`webContents:${event}`)?.(...args);
  }
}

describe("ErrorReportWindowRegistry", () => {
  afterEach(() => {
    latestWindow = null;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("loads one isolated renderer window at the fixed error-report route", async () => {
    const { ErrorReportWindowRegistry } = await loadErrorReportWindowModule();
    const registry = new ErrorReportWindowRegistry(createDependencies());

    const window = registry.open(makeContext("renderer-process"));

    expect(window).toBe(latestWindow);
    expect(latestWindow?.options).toMatchObject({
      width: 720,
      height: 780,
      minWidth: 360,
      minHeight: 520,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    expect(applyRendererWindowGuards).toHaveBeenCalledWith(
      window,
      "file:///C:/app/renderer/index.html",
    );
    expect(loadRendererIntoWindow).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        productionRendererPath: "C:\\app\\renderer\\index.html",
      }),
      "error-report",
    );
    expect(latestWindow?.show).not.toHaveBeenCalled();
    latestWindow?.emit("ready-to-show");
    expect(latestWindow?.show).toHaveBeenCalledTimes(1);
    expect(latestWindow?.focus).toHaveBeenCalledTimes(1);
  });

  it("sends the in-memory context after load and trusts only its sender", async () => {
    const { ErrorReportWindowRegistry } = await loadErrorReportWindowModule();
    const registry = new ErrorReportWindowRegistry(createDependencies());
    const context = makeContext("renderer-process");

    registry.open(context);
    const window = requireLatestWindow();
    expect(window.webContents.send).not.toHaveBeenCalled();

    window.emitWebContents("did-finish-load");

    expect(window.webContents.send).toHaveBeenCalledWith(
      "error-report:incident",
      context,
    );
    expect(registry.isTrustedSender(window.webContents.id)).toBe(true);
    expect(registry.isTrustedSender(window.webContents.id + 1)).toBe(false);
  });

  it("reuses the live window and replaces its current context", async () => {
    const { ErrorReportWindowRegistry } = await loadErrorReportWindowModule();
    const registry = new ErrorReportWindowRegistry(createDependencies());
    registry.open(makeContext("renderer-process"));
    const first = requireLatestWindow();
    first.minimized = true;

    const secondContext = makeContext("main-process");
    const second = registry.open(secondContext);

    expect(second).toBe(first);
    expect(loadRendererIntoWindow).toHaveBeenCalledTimes(1);
    expect(first.restore).toHaveBeenCalledTimes(1);
    expect(first.show).toHaveBeenCalledTimes(1);
    expect(first.focus).toHaveBeenCalledTimes(1);
    expect(first.webContents.send).toHaveBeenLastCalledWith(
      "error-report:incident",
      secondContext,
    );
  });

  it("clears trust when the window closes or is destroyed", async () => {
    const { ErrorReportWindowRegistry } = await loadErrorReportWindowModule();
    const registry = new ErrorReportWindowRegistry(createDependencies());
    registry.open(makeContext("renderer-process"));
    const window = requireLatestWindow();

    registry.close();
    expect(window.close).toHaveBeenCalledTimes(1);
    expect(registry.getWindow()).toBeNull();
    expect(registry.isTrustedSender(window.webContents.id)).toBe(false);

    registry.open(makeContext("main-process"));
    const replacement = requireLatestWindow();
    registry.closeAll();
    expect(replacement.destroy).toHaveBeenCalledTimes(1);
    expect(registry.getWindow()).toBeNull();
  });
});

function makeContext(source: ErrorReportContext["source"]): ErrorReportContext {
  return {
    source,
    summary: "The renderer stopped unexpectedly.",
    message: "Render process gone",
    stack: "Error: Render process gone\n    at C:\\Users\\name\\app.ts:1:1",
  };
}

function requireLatestWindow(): FakeBrowserWindow {
  if (!latestWindow) {
    throw new Error("Expected ErrorReportWindowRegistry to create a window.");
  }
  return latestWindow;
}

function createDependencies() {
  return {
    applyRendererWindowGuards,
    incidentChannel: "error-report:incident",
    loadRendererIntoWindow,
    parseContext: parseErrorIncident,
    rendererWebPreferences,
    resolveRendererLoadTarget,
    title: () => "Carrot Manga Translator",
  };
}

async function loadErrorReportWindowModule(): Promise<
  typeof import("../src/main/errorReportWindow")
> {
  vi.resetModules();
  latestWindow = null;
  vi.doMock("electron", () => ({
    BrowserWindow: FakeBrowserWindow,
  }));
  return import("../src/main/errorReportWindow");
}
