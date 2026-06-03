import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MangaPage } from "../src/shared/types";

type Listener = (...args: any[]) => void;

const tempDirs: string[] = [];
let latestWindow: FakeExportWindow | null = null;

class FakeExportWindow {
  options: any;
  loadedHtml = "";
  listeners = new Map<string, Listener>();
  windowOpenHandler: (() => { action: "deny" | "allow" }) | null = null;
  destroy = vi.fn();
  webContents = {
    setWindowOpenHandler: vi.fn((handler: () => { action: "deny" | "allow" }) => {
      this.windowOpenHandler = handler;
    }),
    on: vi.fn((event: string, listener: Listener) => {
      this.listeners.set(event, listener);
    }),
    executeJavaScript: vi.fn(async (script: string) => {
      if (script.trim() === "window.__exportPngDataUrl") {
        return "data:image/png;base64,b3V0";
      }
      return true;
    })
  };

  constructor(options: any) {
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
    await writeFile(join(rootDir, "src", "renderer", "src", "styles.css"), "body { color: red; }", "utf8");
    const { renderPageWithTranslationBlocksForExport } = await loadPageExport(rootDir);

    const png = await renderPageWithTranslationBlocksForExport(makePage(rootDir), {
      dataRoot: rootDir,
      decodeFallback: async () => null
    });

    expect(png.toString()).toBe("out");
    expect(latestWindow?.options.webPreferences).toMatchObject({
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    });
    expect(latestWindow?.windowOpenHandler?.()).toEqual({ action: "deny" });

    const blockedEvent = { preventDefault: vi.fn() };
    latestWindow?.listeners.get("will-navigate")?.(blockedEvent, "https://example.test/");
    expect(blockedEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(latestWindow?.loadedHtml).not.toContain("src/renderer/src/styles.css");
  });
});

async function createTempRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-page-export-"));
  tempDirs.push(rootDir);
  return rootDir;
}

async function loadPageExport(rootDir: string): Promise<typeof import("../src/main/pageExport")> {
  vi.resetModules();
  latestWindow = null;
  vi.doMock("electron", () => ({
    BrowserWindow: FakeExportWindow,
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 16, height: 16 }),
        toPNG: () => Buffer.from("source")
      })
    }
  }));
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      isPackaged: true,
      repoRoot: rootDir,
      fontsDir: join(rootDir, "fonts")
    })
  }));
  vi.doMock("../src/main/customFonts", () => ({
    listCustomFonts: () => [],
    resolveCustomFontFilePath: () => null
  }));
  return import("../src/main/pageExport");
}

function makePage(rootDir: string): MangaPage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "001.png",
    imagePath: join(rootDir, "001.png"),
    dataUrl: "",
    width: 16,
    height: 16,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
