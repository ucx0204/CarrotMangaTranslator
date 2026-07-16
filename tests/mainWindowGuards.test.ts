import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Listener = (...args: unknown[]) => void;

let latestWindow: FakeBrowserWindow | null = null;

class FakeBrowserWindow {
  options: unknown;
  listeners = new Map<string, Listener>();
  windowOpenHandler:
    | ((details: { url: string }) => { action: "deny" | "allow" })
    | null = null;
  loadFile = vi.fn(async () => undefined);
  loadURL = vi.fn(async () => undefined);
  setMenuBarVisibility = vi.fn();
  isDestroyed = vi.fn(() => false);
  on = vi.fn((event: string, listener: Listener) => {
    this.listeners.set(`window:${event}`, listener);
    return this;
  });
  webContents = {
    on: vi.fn((event: string, listener: Listener) => {
      this.listeners.set(event, listener);
    }),
    setWindowOpenHandler: vi.fn(
      (handler: (details: { url: string }) => { action: "deny" | "allow" }) => {
        this.windowOpenHandler = handler;
      },
    ),
    isDestroyed: vi.fn(() => false),
  };

  constructor(options: unknown) {
    this.options = options;
    latestWindow = this;
  }
}

describe("main window navigation guards", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ELECTRON_RENDERER_URL;
    latestWindow = null;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("reports renderer crashes and only reports sustained unresponsiveness", async () => {
    vi.useFakeTimers();
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
    const { createMainWindow } = await loadMainWindowModule();
    const onRendererIncident = vi.fn();

    createMainWindow({ onRendererIncident });
    latestWindow?.listeners.get("render-process-gone")?.(
      {},
      { reason: "crashed", exitCode: 9 },
    );
    expect(onRendererIncident).toHaveBeenCalledWith({
      source: "renderer-process",
      summary: "Renderer process stopped unexpectedly",
      message: "Renderer process terminated: crashed (exit 9)",
    });

    latestWindow?.listeners.get("window:unresponsive")?.();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(onRendererIncident).toHaveBeenCalledTimes(1);
    latestWindow?.listeners.get("window:responsive")?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(onRendererIncident).toHaveBeenCalledTimes(1);

    latestWindow?.listeners.get("window:unresponsive")?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onRendererIncident).toHaveBeenLastCalledWith({
      source: "renderer-process",
      summary: "Renderer window is not responding",
      message: "The renderer stayed unresponsive for at least 5 seconds.",
    });
  });

  it("surfaces only main-frame renderer load failures", async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
    const { createMainWindow } = await loadMainWindowModule();
    const onRendererLoadFailure = vi.fn();

    createMainWindow({ onRendererLoadFailure });
    const listener = latestWindow?.listeners.get("did-fail-load");
    listener?.({}, -7, "Timed out", "http://localhost:5173/", false);
    listener?.({}, -3, "Aborted", "http://localhost:5173/", true);
    expect(onRendererLoadFailure).not.toHaveBeenCalled();
    listener?.({}, -105, "Name not resolved", "http://localhost:5173/", true);
    expect(onRendererLoadFailure).toHaveBeenCalledWith({
      errorCode: -105,
      errorDescription: "Name not resolved",
      validatedURL: "http://localhost:5173/",
    });
  });

  it("denies renderer-created windows and blocks external navigation", async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
    const { createMainWindow } = await loadMainWindowModule();

    createMainWindow();
    expect(latestWindow?.loadURL).toHaveBeenCalledWith(
      "http://localhost:5173/",
    );
    expect(
      latestWindow?.windowOpenHandler?.({ url: "https://example.test" }),
    ).toEqual({ action: "deny" });

    const allowedEvent = { preventDefault: vi.fn() };
    latestWindow?.listeners.get("will-navigate")?.(
      allowedEvent,
      "http://localhost:5173/editor",
    );
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled();

    const blockedEvent = { preventDefault: vi.fn() };
    latestWindow?.listeners.get("will-navigate")?.(
      blockedEvent,
      "https://example.test/",
    );
    expect(blockedEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("allows only file navigations inside the packaged renderer directory", async () => {
    const { isAllowedMainWindowNavigation } = await loadMainWindowModule();
    const rendererIndexUrl = pathToFileURL(
      join("C:", "app", "renderer", "index.html"),
    ).toString();
    const rendererAssetUrl = pathToFileURL(
      join("C:", "app", "renderer", "assets", "index.css"),
    ).toString();
    const outsideUrl = pathToFileURL(
      join("C:", "app", "outside.html"),
    ).toString();

    expect(
      isAllowedMainWindowNavigation(rendererAssetUrl, rendererIndexUrl),
    ).toBe(true);
    expect(isAllowedMainWindowNavigation(outsideUrl, rendererIndexUrl)).toBe(
      false,
    );
    expect(
      isAllowedMainWindowNavigation("https://example.test/", rendererIndexUrl),
    ).toBe(false);
  });
});

async function loadMainWindowModule(): Promise<
  typeof import("../src/main/mainWindow")
> {
  vi.resetModules();
  latestWindow = null;
  vi.doMock("electron", () => ({
    app: {
      isPackaged: false,
    },
    BrowserWindow: FakeBrowserWindow,
  }));
  vi.doMock("../src/main/logger", () => ({
    logError: vi.fn(),
    writeLog: vi.fn(),
  }));
  return import("../src/main/mainWindow");
}
