import { BrowserWindow, nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MangaPage } from "../shared/types";
import { buildPageExportHtml } from "./pageExportHtml";
import type { ImageDecodeFallback } from "./regionCrop";

export async function renderPageWithTranslationBlocksForExport(
  page: MangaPage,
  options: {
    dataRoot: string;
    decodeFallback: ImageDecodeFallback;
  }
): Promise<Buffer> {
  const sourcePath = page.inpaintedImagePath || page.imagePath;
  const image = await loadImageForPngExport(sourcePath, options.decodeFallback);
  const size = image.getSize();
  const width = Math.max(1, size.width || page.width);
  const height = Math.max(1, size.height || page.height);
  const imageDataUrl = `data:image/png;base64,${image.toPNG().toString("base64")}`;
  const html = buildPageExportHtml(page, imageDataUrl, width, height);
  const renderDir = join(options.dataRoot, "tmp", "png-export-render");
  await mkdir(renderDir, { recursive: true });
  const htmlPath = join(renderDir, `${page.id}-${randomUUID()}.html`);
  const htmlUrl = pathToFileURL(htmlPath).toString();
  const win = new BrowserWindow({
    width: Math.min(1200, width),
    height: Math.min(1000, height),
    show: false,
    useContentSize: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== htmlUrl) {
      event.preventDefault();
    }
  });

  try {
    await writeFile(htmlPath, html, "utf8");
    await win.loadFile(htmlPath);
    await waitForExportRenderReady(win);
    const pngDataUrl = await win.webContents.executeJavaScript("window.__exportPngDataUrl", true);
    if (typeof pngDataUrl !== "string" || !pngDataUrl.startsWith("data:image/png;base64,")) {
      throw new Error(`출력 PNG 데이터를 만들지 못했습니다: ${page.name}`);
    }
    const png = Buffer.from(pngDataUrl.slice("data:image/png;base64,".length), "base64");
    if (!png.length) {
      throw new Error(`출력 PNG를 만들지 못했습니다: ${page.name}`);
    }
    return png;
  } finally {
    win.destroy();
    await rm(htmlPath, { force: true }).catch(() => {});
  }
}

export function sanitizeOutputBaseName(value: string): string {
  const raw = basename(value, extname(value)) || "page";
  const cleaned = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return (cleaned || "page").slice(0, 80);
}

async function loadImageForPngExport(imagePath: string, decodeFallback: ImageDecodeFallback): Promise<Electron.NativeImage> {
  const direct = nativeImage.createFromPath(imagePath);
  if (!direct.isEmpty()) {
    return direct;
  }

  const pngBuffer = await decodeFallback(imagePath);
  if (pngBuffer) {
    const converted = nativeImage.createFromBuffer(pngBuffer);
    if (!converted.isEmpty()) {
      return converted;
    }
  }

  throw new Error(`출력할 이미지를 읽지 못했습니다: ${imagePath}`);
}

async function waitForExportRenderReady(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        if (document.body && document.body.dataset.ready === "1") {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt > 15000) {
          reject(new Error("PNG export render timeout"));
          return;
        }
        setTimeout(tick, 40);
      };
      tick();
    })
  `);
}
