import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MangaPage } from "../src/shared/libraryTypes";

type Listener = (...args: unknown[]) => void;
type ExportWindowOptions = {
  width?: number;
  height?: number;
  webPreferences?: Record<string, unknown>;
};
type DevToolsScreenshotResponse = {
  data?: string;
};

const tempDirs: string[] = [];
const devToolsOutput = Buffer.from("out").toString("base64");
let latestWindow: FakeExportWindow | null = null;
let sourceImageSize = { width: 16, height: 16 };
let devToolsScreenshotResult: DevToolsScreenshotResponse | Error = {
  data: devToolsOutput,
};

class FakeExportWindow {
  options: ExportWindowOptions;
  loadedHtml = "";
  debuggerAttached = false;
  listeners = new Map<string, Listener>();
  windowOpenHandler: (() => { action: "deny" | "allow" }) | null = null;
  destroy = vi.fn();
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
      return true;
    }),
    capturePage: vi.fn(async () => ({
      toPNG: () => Buffer.from("fallback"),
    })),
    debugger: {
      isAttached: vi.fn(() => this.debuggerAttached),
      attach: vi.fn(() => {
        this.debuggerAttached = true;
      }),
      sendCommand: vi.fn(async (method: string) => {
        if (method !== "Page.captureScreenshot") {
          return {};
        }
        if (devToolsScreenshotResult instanceof Error) {
          throw devToolsScreenshotResult;
        }
        return devToolsScreenshotResult;
      }),
      detach: vi.fn(() => {
        this.debuggerAttached = false;
      }),
    },
  };

  constructor(options: ExportWindowOptions) {
    this.options = options;
    latestWindow = this;
  }

  async loadFile(htmlPath: string): Promise<void> {
    this.loadedHtml = readFileSync(htmlPath, "utf8");
  }
}

describe("page export BrowserWindow security", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    latestWindow = null;
    sourceImageSize = { width: 16, height: 16 };
    devToolsScreenshotResult = { data: devToolsOutput };
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("uses sandboxed offscreen preferences and skips source CSS fallback when packaged", async () => {
    const rootDir = await createTempRoot();
    await mkdir(join(rootDir, "src", "renderer", "src"), { recursive: true });
    await writeFile(
      join(rootDir, "src", "renderer", "src", "styles.css"),
      "body { color: red; }",
      "utf8",
    );
    const { renderPageWithTranslationBlocksForExport } =
      await loadPageExport(rootDir);

    const png = await renderPageWithTranslationBlocksForExport(
      makePage(rootDir),
      {
        dataRoot: rootDir,
        decodeFallback: async () => null,
      },
    );

    expect(png.toString()).toBe("out");
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

  it("keeps the hidden export window bounded but captures the full page clip", async () => {
    sourceImageSize = { width: 5000, height: 12000 };
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } =
      await loadPageExport(rootDir);

    const png = await renderPageWithTranslationBlocksForExport(
      makePage(rootDir),
      {
        dataRoot: rootDir,
        decodeFallback: async () => null,
      },
    );

    expect(png.toString()).toBe("out");
    expect(latestWindow?.options.width).toBe(4096);
    expect(latestWindow?.options.height).toBe(4096);
    expect(latestWindow?.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: 5000,
          height: 12000,
          scale: 1,
        },
      }),
    );
  });

  it("falls back to capturePage if DevTools capture is unavailable", async () => {
    devToolsScreenshotResult = new Error("capture failed");
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } =
      await loadPageExport(rootDir);

    const png = await renderPageWithTranslationBlocksForExport(
      makePage(rootDir),
      {
        dataRoot: rootDir,
        decodeFallback: async () => null,
      },
    );

    expect(png.toString()).toBe("fallback");
    expect(latestWindow?.webContents.capturePage).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 16,
      height: 16,
    });
  });

  it("renders export text through the same safe DOM overlay shape as the editor", async () => {
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } =
      await loadPageExport(rootDir);

    await renderPageWithTranslationBlocksForExport(makePage(rootDir, true), {
      dataRoot: rootDir,
      decodeFallback: async () => null,
    });

    expect(latestWindow?.loadedHtml).not.toContain('replace(/\\s+/g, "")');
    expect(latestWindow?.loadedHtml).not.toContain("<canvas");
    expect(latestWindow?.loadedHtml).toContain("overlay-text-content");
    expect(latestWindow?.loadedHtml).toContain("span.textContent");
    expect(latestWindow?.loadedHtml).toContain("overlay-text-line");
    expect(latestWindow?.loadedHtml).toContain("rect.width / scaleX");
    expect(latestWindow?.loadedHtml).toContain(
      'textContent.style.overflowWrap = fixedLines ? "normal" : "";',
    );
    expect(latestWindow?.loadedHtml).toContain('"renderDirection":"vertical"');
  });

  it("escapes user text with markup so it can never become live HTML", async () => {
    const rootDir = await createTempRoot();
    const { renderPageWithTranslationBlocksForExport } =
      await loadPageExport(rootDir);

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

    await renderPageWithTranslationBlocksForExport(page, {
      dataRoot: rootDir,
      decodeFallback: async () => null,
    });

    const html = latestWindow?.loadedHtml ?? "";
    // The raw closing tag from user text must never appear verbatim.
    expect(html).not.toContain("<script>alert(1)</script>");
    // It is serialized into the data block as escaped JSON instead.
    expect(html).toContain("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");
    // Markup is parsed into safe style runs (the bold marker is stripped).
    expect(html).toContain('"text":"굵게","bold":true');
  });
});

async function createTempRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-page-export-"));
  tempDirs.push(rootDir);
  return rootDir;
}

async function loadPageExport(
  rootDir: string,
): Promise<typeof import("../src/main/pageExport")> {
  vi.resetModules();
  latestWindow = null;
  vi.doMock("electron", () => ({
    BrowserWindow: FakeExportWindow,
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        getSize: () => sourceImageSize,
        toPNG: () => Buffer.from("source"),
      }),
    },
  }));
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      isPackaged: true,
      repoRoot: rootDir,
      fontsDir: join(rootDir, "fonts"),
    }),
  }));
  vi.doMock("../src/main/customFonts", () => ({
    listCustomFonts: () => [],
    resolveCustomFontFilePath: () => null,
  }));
  return import("../src/main/pageExport");
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
