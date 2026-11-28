import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

type Listener = (...args: unknown[]) => void;

let latestWindow: FakeBrowserWindow | null = null;

class FakeBrowserWindow {
  options: unknown;
  listeners = new Map<string, Listener>();
  windowOpenHandler:
    ((details: { url: string }) => { action: "deny" | "allow" }) | null = null;
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
    isCrashed: vi.fn(() => false),
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
    const onRendererFailure = vi.fn();
    const diagnostics = createDiagnostics();

    createMainWindow({ onRendererIncident, onRendererFailure }, diagnostics);
    latestWindow?.listeners.get("render-process-gone")?.(
      {},
      { reason: "crashed", exitCode: -2147483645 },
    );
    expect(onRendererFailure).toHaveBeenCalledWith(
      "main: crashed (exit -2147483645)",
    );
    expect(diagnostics.error).toHaveBeenCalledWith(
      "Renderer process gone",
      expect.objectContaining({ role: "main" }),
    );
    expect(onRendererIncident).not.toHaveBeenCalled();

    latestWindow?.listeners.get("window:unresponsive")?.();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(onRendererIncident).not.toHaveBeenCalled();
    latestWindow?.listeners.get("window:responsive")?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(onRendererIncident).not.toHaveBeenCalled();

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
    const onRendererFailure = vi.fn();

    createMainWindow({ onRendererFailure }, createDiagnostics());
    const listener = latestWindow?.listeners.get("did-fail-load");
    listener?.({}, -7, "Timed out", "http://localhost:5173/", false);
    listener?.({}, -3, "Aborted", "http://localhost:5173/", true);
    expect(onRendererFailure).not.toHaveBeenCalled();
    listener?.({}, -105, "Name not resolved", "http://localhost:5173/", true);
    expect(onRendererFailure).toHaveBeenCalledWith(
      "main: Name not resolved (-105)\nhttp://localhost:5173/",
    );
  });

  it("routes rejected navigations to recovery and ignores superseded or closed windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carrot-navigation-"));
    vi.stubEnv("MANGA_TRANSLATOR_LOG_PATH", join(dir, "app.log"));
    try {
      const {
        createMainWindow,
        resolveRendererLoadTarget,
        loadRendererIntoWindow,
      } = await loadMainWindowModule();
      const window = createMainWindow({}, createDiagnostics());
      const fake = latestWindow;
      if (!fake) throw new Error("Expected an editor window");
      const target = resolveRendererLoadTarget();
      const onFailure = vi.fn();
      fake.loadFile.mockRejectedValueOnce(new Error("Missing renderer page"));
      loadRendererIntoWindow(window, target, "error-report", onFailure);
      await vi.waitFor(() =>
        expect(onFailure).toHaveBeenCalledExactlyOnceWith(
          "Missing renderer page",
        ),
      );
      const dev = { ...target, devRendererUrl: "http://localhost:5173/" };
      fake.loadURL.mockRejectedValueOnce(
        Object.assign(new Error("Aborted"), { code: "ERR_ABORTED" }),
      );
      loadRendererIntoWindow(window, dev, "error-report", onFailure);
      expect(fake.loadURL).toHaveBeenCalledWith(
        "http://localhost:5173/#error-report",
      );
      await Promise.resolve();
      fake.isDestroyed.mockReturnValue(true);
      fake.loadFile.mockRejectedValueOnce(new Error("Window closed"));
      loadRendererIntoWindow(window, target, undefined, onFailure);
      await Promise.resolve();
      expect(onFailure).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("denies renderer-created windows and blocks external navigation", async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
    const { createMainWindow } = await loadMainWindowModule();

    createMainWindow({}, createDiagnostics());
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

  it.each(["http://[::1]:5173/", "http://[0:0:0:0:0:0:0:1]:5173/"])(
    "loads the IPv6 loopback development renderer: %s",
    async (url) => {
      process.env.ELECTRON_RENDERER_URL = url;
      const { createMainWindow } = await loadMainWindowModule();
      createMainWindow({}, createDiagnostics());
      expect(latestWindow?.loadURL).toHaveBeenCalledWith(
        new URL(url).toString(),
      );
      expect(latestWindow?.loadFile).not.toHaveBeenCalled();
      const event = { preventDefault: vi.fn() };
      latestWindow?.listeners.get("will-navigate")?.(
        event,
        "http://[::2]:5173/",
      );
      expect(event.preventDefault).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "https://[::1]:5173/",
    "http://[::2]:5173/",
    "http://example.test:5173/",
  ])("still rejects unsupported development addresses: %s", async (url) => {
    process.env.ELECTRON_RENDERER_URL = url;
    const { createMainWindow } = await loadMainWindowModule();
    createMainWindow({}, createDiagnostics());
    expect(latestWindow?.loadURL).not.toHaveBeenCalled();
    expect(latestWindow?.loadFile).toHaveBeenCalledOnce();
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
  return import("../src/main/mainWindow");
}

function createDiagnostics() {
  return {
    error: vi.fn(),
    write: vi.fn(),
  };
}
