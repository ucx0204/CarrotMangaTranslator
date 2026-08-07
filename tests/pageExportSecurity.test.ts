import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MangaPage } from "../src/shared/libraryTypes";
import {
  createPageExportHtmlSource,
  type PageExportHtmlSource,
} from "../src/main/pageExportHtml";

type Listener = (...args: unknown[]) => void;
type ExportWindowOptions = {
  width?: number;
  height?: number;
  webPreferences?: Record<string, unknown>;
};
type DevToolsScreenshotResponse = {
  data?: string;
};
type StalledExportPhase =
  | "page-load"
  | "render-readiness"
  | "debugger-setup"
  | "screenshot-capture";
type ExportOutcome =
  | { status: "fulfilled" }
  | { status: "rejected"; message: string };

const tempDirs: string[] = [];
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
let latestWindow: FakeExportWindow | null = null;
let probedImageSize = { width: 16, height: 16 };
let rendererImageSize = { width: 16, height: 16 };
let devToolsScreenshotResult: DevToolsScreenshotResponse | Error = {
  data: fakePng(16, 16).toString("base64"),
};
let stalledExportPhase: StalledExportPhase | null = null;
let exportEvents: string[] = [];
const exportEventWaiters = new Map<string, Array<() => void>>();
let debuggerDetachError: Error | null = null;

class FakeExportWindow {
  options: ExportWindowOptions;
  loadedHtml = "";
  debuggerAttached = false;
  listeners = new Map<string, Listener>();
  windowOpenHandler: (() => { action: "deny" | "allow" }) | null = null;
  destroy = vi.fn();
  setContentSize = vi.fn();
  webContents = {
    setWindowOpenHandler: vi.fn(
      (handler: () => { action: "deny" | "allow" }) => {
        this.windowOpenHandler = handler;
      },
    ),
    on: vi.fn((event: string, listener: Listener) => {
      this.listeners.set(event, listener);
    }),
    executeJavaScript: vi.fn(async (script: string) => {
      void script;
      recordExportEvent("render-readiness:start");
      if (stalledExportPhase === "render-readiness") {
        return pendingForever();
      }
      recordExportEvent("render-readiness:done");
      return rendererImageSize;
    }),
    capturePage: vi.fn(async () => ({
      toPNG: () => Buffer.from("fallback"),
    })),
    debugger: {
      isAttached: vi.fn(() => this.debuggerAttached),
      attach: vi.fn(() => {
        recordExportEvent("debugger:attach");
        this.debuggerAttached = true;
      }),
      sendCommand: vi.fn(
        async (
          method: string,
          parameters?: { clip?: { width: number; height: number } },
        ) => {
          recordExportEvent(`cdp:${method}:start`);
          if (
            (method === "Page.enable" &&
              stalledExportPhase === "debugger-setup") ||
            (method === "Page.captureScreenshot" &&
              stalledExportPhase === "screenshot-capture")
          ) {
            return pendingForever();
          }
          if (method !== "Page.captureScreenshot") {
            recordExportEvent(`cdp:${method}:done`);
            return {};
          }
          if (devToolsScreenshotResult instanceof Error) {
            throw devToolsScreenshotResult;
          }
          const clip = parameters?.clip;
          const result = clip
            ? {
                data: fakePng(clip.width, clip.height).toString("base64"),
              }
            : devToolsScreenshotResult;
          recordExportEvent(`cdp:${method}:done`);
          return result;
        },
      ),
      detach: vi.fn(() => {
        if (debuggerDetachError) throw debuggerDetachError;
        this.debuggerAttached = false;
      }),
    },
  };

  constructor(options: ExportWindowOptions) {
    this.options = options;
    latestWindow = this;
  }

  async loadFile(htmlPath: string): Promise<void> {
    recordExportEvent("page-load:start");
    this.loadedHtml = readFileSync(htmlPath, "utf8");
    if (stalledExportPhase === "page-load") {
      return pendingForever();
    }
    recordExportEvent("page-load:done");
  }
}

describe("page export BrowserWindow security", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    latestWindow = null;
    probedImageSize = { width: 16, height: 16 };
    rendererImageSize = { width: 16, height: 16 };
    devToolsScreenshotResult = {
      data: fakePng(16, 16).toString("base64"),
    };
    stalledExportPhase = null;
    exportEvents = [];
    exportEventWaiters.clear();
    debuggerDetachError = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("does not attach the debugger until the page has loaded and declared itself ready", async () => {
    const rootDir = await createTempRoot();
    const { createPageExportRenderSession } = await loadPageExport();
    const session = await createPageExportRenderSession(
      createRenderOptions(rootDir),
    );

    expect(latestWindow?.webContents.debugger.attach).not.toHaveBeenCalled();
    expect(
      latestWindow?.webContents.debugger.sendCommand,
    ).not.toHaveBeenCalled();

    try {
      await session.renderPage(makePage(rootDir));
    } finally {
      session.close();
    }

    expectEventBefore("page-load:done", "render-readiness:start");
    expectEventBefore("render-readiness:done", "debugger:attach");
    expectEventBefore("debugger:attach", "cdp:Page.enable:start");
  });

  it("destroys the export window even when debugger detachment fails", async () => {
    const rootDir = await createTempRoot();
    const { createPageExportRenderSession } = await loadPageExport();
    const session = await createPageExportRenderSession(
      createRenderOptions(rootDir),
    );
    const exportWindow = latestWindow;
    if (!exportWindow) throw new Error("Expected an export window.");
    exportWindow.debuggerAttached = true;
    exportWindow.webContents.debugger.detach.mockImplementationOnce(() => {
      throw new Error("detach failed");
    });

    expect(() => session.close()).toThrow("detach failed");
    expect(exportWindow.destroy).toHaveBeenCalledOnce();
  });

  it("keeps the render failure primary when debugger cleanup also fails", async () => {
    devToolsScreenshotResult = new Error("capture root failed");
    debuggerDetachError = new Error("detach cleanup failed");
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    let failure: unknown;
    try {
      await renderPageWithTranslationBlocksForExport(
        makePage(rootDir),
        createRenderOptions(rootDir),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toContain("capture root failed");
    expect(aggregate.message).toContain("detach cleanup failed");
    expect(aggregate.cause).toMatchObject({ message: "capture root failed" });
    expect(aggregate.errors).toEqual([
      expect.objectContaining({ message: "capture root failed" }),
      expect.objectContaining({ message: "detach cleanup failed" }),
    ]);
    expect(latestWindow?.destroy).toHaveBeenCalledOnce();
  });

  it("aborts and rejects an image decoder that never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const rootDir = await createTempRoot();
    const options = createRenderOptions(rootDir);
    options.resolveImageUrl = () => {
      throw new Error("image protocol unavailable");
    };
    let decodeSignal: AbortSignal | undefined;
    options.decodeFallback = (_filePath, signal) => {
      decodeSignal = signal;
      recordExportEvent("image-decode:start");
      return pendingForever();
    };
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();
    let outcome: ExportOutcome | undefined;
    const renderPromise = renderPageWithTranslationBlocksForExport(
      makePage(rootDir),
      options,
    );
    void renderPromise.then(
      () => {
        outcome = { status: "fulfilled" };
      },
      (error: unknown) => {
        outcome = {
          status: "rejected",
          message: error instanceof Error ? error.message : String(error),
        };
      },
    );

    await waitForExportEvent("image-decode:start");
    await vi.advanceTimersByTimeAsync(60_000);
    await waitForExportOutcome(() => outcome !== undefined);

    expect(outcome).toEqual({
      status: "rejected",
      message: "PNG export image preflight timeout",
    });
    expect(decodeSignal?.aborted).toBe(true);
    expect(latestWindow?.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    {
      phase: "page-load" as const,
      startedEvent: "page-load:start",
      expectedError: /^PNG export .*load.* timeout$/i,
    },
    {
      phase: "render-readiness" as const,
      startedEvent: "render-readiness:start",
      expectedError: /^PNG export .*render.*read(?:y|iness).* timeout$/i,
    },
    {
      phase: "debugger-setup" as const,
      startedEvent: "cdp:Page.enable:start",
      expectedError: /^PNG export .*(?:debugger|cdp|Page\.enable).* timeout$/i,
    },
    {
      phase: "screenshot-capture" as const,
      startedEvent: "cdp:Page.captureScreenshot:start",
      expectedError: /^PNG export .*(?:capture|screenshot).* timeout$/i,
    },
  ])(
    "fails a stalled $phase phase with a bounded, phase-specific error",
    async ({ phase, startedEvent, expectedError }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      stalledExportPhase = phase;
      const rootDir = await createTempRoot();
      const { renderPageWithTranslationBlocksForExport } =
        await loadPageExport();
      let outcome: ExportOutcome | undefined;
      const renderPromise = renderPageWithTranslationBlocksForExport(
        makePage(rootDir),
        createRenderOptions(rootDir),
      );
      void renderPromise.then(
        () => {
          outcome = { status: "fulfilled" };
        },
        (error: unknown) => {
          outcome = {
            status: "rejected",
            message: error instanceof Error ? error.message : String(error),
          };
        },
      );

      await waitForExportEvent(startedEvent);
      await vi.advanceTimersByTimeAsync(60_000);
      await waitForExportOutcome(() => outcome !== undefined);

      expect(
        outcome,
        `${phase} did not settle after the bounded timeout`,
      ).toBeDefined();
      expect(outcome?.status).toBe("rejected");
      if (outcome?.status === "rejected") {
        expect(outcome.message).toMatch(expectedError);
      }
      expect(latestWindow?.destroy).toHaveBeenCalledOnce();
    },
  );

  it("fails explicitly when dedicated assets are missing", async () => {
    const rootDir = await createEmptyTempRoot();
    await mkdir(join(rootDir, "src", "renderer", "src"), { recursive: true });
    await writeFile(
      join(rootDir, "src", "renderer", "src", "styles.css"),
      "body { color: red; }",
      "utf8",
    );
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    await expect(
      renderPageWithTranslationBlocksForExport(
        makePage(rootDir),
        createRenderOptions(rootDir),
      ),
    ).rejects.toThrow("Page export assets are missing");
    expect(latestWindow?.destroy).toHaveBeenCalledOnce();
  });

  it("omits a custom font face when its catalog file is missing", async () => {
    const rootDir = await createTempRoot();
    const customId = "11111111-1111-4111-8111-111111111111";
    const source = createPageExportHtmlSource({
      assetDirectories: () => [join(rootDir, "out", "page-export")],
      rendererStylesheet: () =>
        pathToFileURL(
          join(rootDir, "out", "renderer", "styles.css"),
        ).toString(),
      fonts: {
        list: () => [
          {
            id: customId,
            label: "Missing",
            family: `MGTUser-${customId}`,
            fileName: `${customId}.ttf`,
          },
        ],
        readPreferences: () => ({
          favoriteIds: [],
          orderedIds: [],
          defaultFontId: customId,
        }),
        resolveFilePath: () => null,
      },
    });

    const html = source.buildHtml(makePage(rootDir), "data:image/png;base64,", {
      width: 16,
      height: 16,
    });

    expect(html).not.toContain("@font-face");
    expect(html).not.toContain(`url("file:`);
  });

  it("uses sandboxed offscreen preferences and skips source CSS fallback when packaged", async () => {
    const rootDir = await createTempRoot();
    await mkdir(join(rootDir, "src", "renderer", "src"), { recursive: true });
    await writeFile(
      join(rootDir, "src", "renderer", "src", "styles.css"),
      "body { color: red; }",
      "utf8",
    );
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    const png = await renderPageWithTranslationBlocksForExport(
      makePage(rootDir),
      createRenderOptions(rootDir),
    );

    expect(readFakePngSize(png)).toEqual({ width: 16, height: 16 });
    expect(latestWindow?.options.webPreferences).toMatchObject({
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
    expect(latestWindow?.windowOpenHandler?.()).toEqual({ action: "deny" });

    const blockedEvent = { preventDefault: vi.fn() };
    latestWindow?.listeners.get("will-navigate")?.(
      blockedEvent,
      "https://example.test/",
    );
    expect(blockedEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(latestWindow?.loadedHtml).not.toContain(
      "src/renderer/src/styles.css",
    );
    expect(latestWindow?.webContents.capturePage).not.toHaveBeenCalled();
    expect(latestWindow?.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: 16,
          height: 16,
          scale: 1,
        },
      },
    );
  });

  it("rejects an oversized source before page load or debugger attach", async () => {
    probedImageSize = { width: 5000, height: 12000 };
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    await expect(
      renderPageWithTranslationBlocksForExport(
        makePage(rootDir),
        createRenderOptions(rootDir),
      ),
    ).rejects.toThrow(/안전 해상도|raster safety/i);

    expect(latestWindow?.loadedHtml).toBe("");
    expect(latestWindow?.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(latestWindow?.webContents.debugger.attach).not.toHaveBeenCalled();
    expect(
      latestWindow?.webContents.debugger.sendCommand,
    ).not.toHaveBeenCalled();
    expect(latestWindow?.destroy).toHaveBeenCalledOnce();
  });

  it("skips an oversized inpainted source and safely falls back to the original", async () => {
    const rootDir = await createTempRoot();
    const page = makePage(rootDir);
    const inpaintedPath = join(rootDir, "001-inpainted.png");
    page.inpaintedImagePath = inpaintedPath;
    const options = createRenderOptions(rootDir);
    const probeImageSize = vi.fn(async (imagePath: string) =>
      imagePath === inpaintedPath
        ? { width: 5000, height: 12000 }
        : { width: 2000, height: 3000 },
    );
    const resolveImageUrl = vi.fn(
      (_imagePath: string) => "data:image/png;base64,",
    );
    const decodeFallback = vi.fn(async () => null);
    options.probeImageSize = probeImageSize;
    options.resolveImageUrl = resolveImageUrl;
    options.decodeFallback = decodeFallback;
    rendererImageSize = { width: 2000, height: 3000 };
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    const png = await renderPageWithTranslationBlocksForExport(page, options);

    expect(readFakePngSize(png)).toEqual({ width: 2000, height: 3000 });
    expect(probeImageSize.mock.calls.map(([imagePath]) => imagePath)).toEqual([
      inpaintedPath,
      page.imagePath,
    ]);
    expect(resolveImageUrl).toHaveBeenCalledTimes(1);
    expect(resolveImageUrl).toHaveBeenCalledWith(page.imagePath);
    expect(decodeFallback).not.toHaveBeenCalled();
  });

  it("captures an exact-boundary 4096x4096 page at its original size", async () => {
    probedImageSize = { width: 4096, height: 4096 };
    rendererImageSize = probedImageSize;
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    const png = await renderPageWithTranslationBlocksForExport(
      makePage(rootDir),
      createRenderOptions(rootDir),
    );

    expect(readFakePngSize(png)).toEqual(probedImageSize);
    expect(latestWindow?.setContentSize).toHaveBeenCalledWith(4096, 4096);
  });

  it("keeps a safe long image full-size beyond the bounded viewport", async () => {
    probedImageSize = { width: 2048, height: 8192 };
    rendererImageSize = probedImageSize;
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    const png = await renderPageWithTranslationBlocksForExport(
      makePage(rootDir),
      createRenderOptions(rootDir),
    );

    expect(readFakePngSize(png)).toEqual(probedImageSize);
    expect(latestWindow?.setContentSize).toHaveBeenCalledWith(2048, 4096);
    expect(latestWindow?.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: 2048,
          height: 8192,
          scale: 1,
        },
      }),
    );
  });

  it("rejects a renderer dimension mismatch before debugger attach", async () => {
    probedImageSize = { width: 1000, height: 2000 };
    rendererImageSize = { width: 1000, height: 1999 };
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    await expect(
      renderPageWithTranslationBlocksForExport(
        makePage(rootDir),
        createRenderOptions(rootDir),
      ),
    ).rejects.toThrow(/검사 후 변경|dimensions changed/i);

    expect(latestWindow?.webContents.debugger.attach).not.toHaveBeenCalled();
    expect(
      latestWindow?.webContents.debugger.sendCommand,
    ).not.toHaveBeenCalled();
  });

  it("rejects an unsafe renderer-reported size before debugger attach", async () => {
    probedImageSize = { width: 1000, height: 2000 };
    rendererImageSize = { width: 5000, height: 12000 };
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    await expect(
      renderPageWithTranslationBlocksForExport(
        makePage(rootDir),
        createRenderOptions(rootDir),
      ),
    ).rejects.toThrow(/안전 해상도|raster safety/i);

    expect(latestWindow?.webContents.debugger.attach).not.toHaveBeenCalled();
    expect(
      latestWindow?.webContents.debugger.sendCommand,
    ).not.toHaveBeenCalled();
  });

  it("fails explicitly instead of changing raster paths when DevTools capture is unavailable", async () => {
    devToolsScreenshotResult = new Error("capture failed");
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    await expect(
      renderPageWithTranslationBlocksForExport(
        makePage(rootDir),
        createRenderOptions(rootDir),
      ),
    ).rejects.toThrow("capture failed");
    expect(latestWindow?.webContents.capturePage).not.toHaveBeenCalled();
  });

  it("renders export text through the same safe DOM overlay shape as the editor", async () => {
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    await renderPageWithTranslationBlocksForExport(
      makePage(rootDir, true),
      createRenderOptions(rootDir),
    );

    const html = latestWindow?.loadedHtml ?? "";
    expect(html).toContain('id="page-export-data"');
    expect(html).toMatch(
      /<script src="file:[^"]+runtime\.js" defer><\/script>/,
    );
    expect(html.match(/<link rel="stylesheet"/g)).toHaveLength(2);
    expect(html).not.toContain("src/renderer/src/styles.css");
    expect(html).not.toContain("function renderExportBlocks");
    expect(html).toContain("script-src file:");
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).toContain('"renderDirection":"vertical"');
    expect(html).not.toContain('"wordBreak"');
  });

  it("escapes user text with markup so it can never become live HTML", async () => {
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport();

    const page = makePage(rootDir);
    page.blocks = [
      {
        id: "block-xss",
        type: "nonsolid",
        bbox: { x: 0, y: 0, w: 1000, h: 1000 },
        sourceText: "",
        translatedText: "<script>alert(1)</script> **굵게**",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 20,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
    ];

    await renderPageWithTranslationBlocksForExport(
      page,
      createRenderOptions(rootDir),
    );

    const html = latestWindow?.loadedHtml ?? "";
    // The raw closing tag from user text must never appear verbatim.
    expect(html).not.toContain("<script>alert(1)</script>");
    // It is serialized into the data block as escaped JSON instead.
    expect(html).toContain("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");
    // Markup remains inert JSON and is parsed only by React text nodes.
    expect(html).toContain("**굵게**");
  });
});

function pendingForever<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function recordExportEvent(event: string): void {
  exportEvents.push(event);
  const waiters = exportEventWaiters.get(event);
  if (!waiters) return;
  exportEventWaiters.delete(event);
  for (const resolve of waiters) resolve();
}

function waitForExportEvent(event: string): Promise<void> {
  if (exportEvents.includes(event)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const waiters = exportEventWaiters.get(event) ?? [];
    waiters.push(resolve);
    exportEventWaiters.set(event, waiters);
  });
}

function expectEventBefore(first: string, second: string): void {
  const firstIndex = exportEvents.indexOf(first);
  const secondIndex = exportEvents.indexOf(second);
  expect(firstIndex, `${first} was not recorded`).toBeGreaterThanOrEqual(0);
  expect(secondIndex, `${second} was not recorded`).toBeGreaterThanOrEqual(0);
  expect(firstIndex, `${first} must happen before ${second}`).toBeLessThan(
    secondIndex,
  );
}

async function waitForExportOutcome(hasSettled: () => boolean): Promise<void> {
  for (let turn = 0; turn < 20 && !hasSettled(); turn += 1) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
}

async function createTempRoot(): Promise<string> {
  const rootDir = await createEmptyTempRoot();
  const assetDir = join(rootDir, "out", "page-export");
  const rendererDir = join(rootDir, "out", "renderer");
  await Promise.all([
    mkdir(assetDir, { recursive: true }),
    mkdir(rendererDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(assetDir, "runtime.js"),
      'document.body.dataset.ready = "1";',
      "utf8",
    ),
    writeFile(
      join(assetDir, "styles.css"),
      ".page-export-stage { position: relative; }",
      "utf8",
    ),
    writeFile(
      join(rendererDir, "styles.css"),
      "@font-face { font-family: Test; src: url(test.ttf); }",
      "utf8",
    ),
  ]);
  return rootDir;
}

async function createEmptyTempRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-page-export-"));
  tempDirs.push(rootDir);
  return rootDir;
}

async function loadPageExport(): Promise<
  typeof import("../src/main/pageExport")
> {
  vi.resetModules();
  latestWindow = null;
  vi.doMock("electron", () => ({
    BrowserWindow: FakeExportWindow,
    nativeImage: {
      createFromBuffer: () => ({
        isEmpty: () => false,
        toPNG: () => Buffer.from("source"),
      }),
    },
  }));
  return import("../src/main/pageExport");
}

function createRenderOptions(rootDir: string): {
  dataRoot: string;
  decodeFallback: (
    filePath: string,
    signal?: AbortSignal,
  ) => Promise<Buffer | null>;
  htmlSource: PageExportHtmlSource;
  resolveImageUrl: (path: string) => string;
  probeImageSize: (
    path: string,
    signal: AbortSignal,
  ) => Promise<{ width: number; height: number }>;
} {
  return {
    dataRoot: rootDir,
    decodeFallback: async () => null,
    resolveImageUrl: () => "data:image/png;base64,",
    probeImageSize: async () => probedImageSize,
    htmlSource: createPageExportHtmlSource({
      assetDirectories: () => [join(rootDir, "out", "page-export")],
      rendererStylesheet: () =>
        pathToFileURL(
          join(rootDir, "out", "renderer", "styles.css"),
        ).toString(),
      fonts: {
        list: () => [],
        readPreferences: () => ({
          favoriteIds: [],
          orderedIds: [],
          defaultFontId: "default",
        }),
        resolveFilePath: () => null,
      },
    }),
  };
}

function fakePng(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(13, 8);
  Buffer.from("IHDR", "ascii").copy(png, 12);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function readFakePngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function makePage(rootDir: string, withVerticalBlock = false): MangaPage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "001.png",
    imagePath: join(rootDir, "001.png"),
    dataUrl: "",
    width: 16,
    height: 16,
    blocks: withVerticalBlock
      ? [
          {
            id: "block-1",
            type: "nonsolid",
            bbox: { x: 0, y: 0, w: 1000, h: 1000 },
            sourceText: "가 나",
            translatedText: "가 나",
            confidence: 1,
            sourceDirection: "vertical",
            renderDirection: "vertical",
            fontSizePx: 20,
            lineHeight: 1.2,
            textAlign: "center",
            textColor: "#111111",
            backgroundColor: "#ffffff",
            opacity: 0.9,
          },
        ]
      : [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
