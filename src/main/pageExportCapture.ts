import type { BrowserWindow } from "electron";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES,
  ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
  SAFE_PAGE_EXPORT_RASTER_LIMITS,
  type PageExportRasterSize,
  type PageExportResolutionMode,
} from "../shared/pageExportLimits";
import { tMain } from "./i18n";
import { withTimeout } from "./pageExportLifecycle";
import {
  assertPageExportImageBuffer,
  assertPageExportPngBuffer,
  assertPageExportRasterBudget,
  decodeBoundedPageExportImage,
  decodeBoundedPageExportScreenshot,
} from "./pageExportRasterSafety";
import {
  createPageExportTilePlan,
  PAGE_EXPORT_CAPTURE_TILE_SIDE_PX,
  stitchPageExportTiles,
  type PageExportCapturedTile,
  type PageExportTileStitcher,
} from "./pageExportTileStitch";

const SCREENSHOT_CAPTURE_TIMEOUT_MS = 30_000;
const ORIGINAL_TILE_CAPTURE_TIMEOUT_MS = 60_000;

type DevToolsScreenshotResult = {
  data?: unknown;
};

export type PageExportCaptureOptions = {
  format: "png" | "jpeg" | "webp";
  quality?: number;
  resolutionMode?: PageExportResolutionMode | "strict-safe";
};

export type PageExportCaptureRuntime = {
  temporaryDirectory: string;
  stitchTiles?: PageExportTileStitcher;
};

export async function captureExportPageImage(
  win: BrowserWindow,
  expected: PageExportRasterSize,
  pageName: string,
  options: PageExportCaptureOptions,
  transparentBackground = false,
  runtime?: PageExportCaptureRuntime,
): Promise<Buffer> {
  const rasterLimits =
    options.resolutionMode === "original"
      ? ORIGINAL_PAGE_EXPORT_RASTER_LIMITS
      : SAFE_PAGE_EXPORT_RASTER_LIMITS;
  assertPageExportRasterBudget(expected, pageName, rasterLimits);
  if (transparentBackground && options.format !== "png") {
    throw new Error("Transparent page export requires PNG.");
  }
  if (transparentBackground) {
    await win.webContents.debugger.sendCommand(
      "Emulation.setDefaultBackgroundColorOverride",
      { color: { r: 0, g: 0, b: 0, a: 0 } },
    );
  }
  try {
    if (requiresPageExportTiles(expected)) {
      if (!runtime) {
        throw new Error("Tiled page export requires a temporary directory.");
      }
      return await captureTiledPageExport(
        win,
        expected,
        pageName,
        options,
        runtime,
      );
    }
    return await captureSinglePageExport(win, expected, pageName, options);
  } finally {
    if (transparentBackground) {
      await win.webContents.debugger.sendCommand(
        "Emulation.setDefaultBackgroundColorOverride",
      );
    }
  }
}

function requiresPageExportTiles(expected: PageExportRasterSize): boolean {
  return (
    expected.width > PAGE_EXPORT_CAPTURE_TILE_SIDE_PX ||
    expected.height > PAGE_EXPORT_CAPTURE_TILE_SIDE_PX
  );
}

async function captureSinglePageExport(
  win: BrowserWindow,
  expected: PageExportRasterSize,
  pageName: string,
  options: PageExportCaptureOptions,
): Promise<Buffer> {
  const result = await captureScreenshot(win, {
    format: options.format,
    quality: options.quality,
    clip: { x: 0, y: 0, ...expected, scale: 1 },
    timeoutMs: SCREENSHOT_CAPTURE_TIMEOUT_MS,
  });
  const rasterLimits =
    options.resolutionMode === "original"
      ? ORIGINAL_PAGE_EXPORT_RASTER_LIMITS
      : SAFE_PAGE_EXPORT_RASTER_LIMITS;
  return options.format === "png"
    ? decodeBoundedPageExportScreenshot(result, expected, pageName, {
        rasterLimits,
      })
    : decodeBoundedPageExportImage(result, expected, pageName, options.format, {
        rasterLimits,
      });
}

async function captureTiledPageExport(
  win: BrowserWindow,
  expected: PageExportRasterSize,
  pageName: string,
  options: PageExportCaptureOptions,
  runtime: PageExportCaptureRuntime,
): Promise<Buffer> {
  const plan = createPageExportTilePlan(expected);
  const extension = options.format === "jpeg" ? "jpg" : options.format;
  const outputPath = join(
    runtime.temporaryDirectory,
    `page-export-stitched.${extension}`,
  );
  const tiles: PageExportCapturedTile[] = [];
  try {
    for (const tile of plan) {
      const tileSize = {
        width: tile.captureWidth,
        height: tile.captureHeight,
      };
      const data = await captureScreenshot(win, {
        format: "png",
        clip: {
          x: tile.captureX,
          y: tile.captureY,
          ...tileSize,
          scale: 1,
        },
        timeoutMs: ORIGINAL_TILE_CAPTURE_TIMEOUT_MS,
      });
      const png = decodeBoundedPageExportScreenshot(
        data,
        tileSize,
        `${pageName} tile ${tile.index + 1}`,
      );
      const path = join(
        runtime.temporaryDirectory,
        `page-export-tile-${String(tile.index).padStart(3, "0")}.png`,
      );
      const capturedTile = { ...tile, path };
      tiles.push(capturedTile);
      await writeFile(path, png);
    }
    await rm(outputPath, { force: true });
    await (runtime.stitchTiles ?? stitchPageExportTiles)({
      expected,
      format: options.format,
      outputPath,
      quality: options.quality,
      tiles,
    });
    return await readValidatedTiledOutput(
      outputPath,
      expected,
      pageName,
      options.format,
    );
  } finally {
    await Promise.all([
      ...tiles.map((tile) => rm(tile.path, { force: true })),
      rm(outputPath, { force: true }),
    ]);
  }
}

async function readValidatedTiledOutput(
  outputPath: string,
  expected: PageExportRasterSize,
  pageName: string,
  format: PageExportCaptureOptions["format"],
): Promise<Buffer> {
  const outputStat = await stat(outputPath);
  if (
    !outputStat.isFile() ||
    outputStat.size < 1 ||
    outputStat.size > MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES
  ) {
    throw new Error(
      tMain("export.errors.screenshotTooLarge", { name: pageName }),
    );
  }
  const output = await readFile(outputPath);
  if (format === "png") {
    assertPageExportPngBuffer(
      output,
      expected,
      pageName,
      MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES,
      ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
    );
  } else {
    assertPageExportImageBuffer(
      output,
      expected,
      pageName,
      format,
      MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES,
      ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
    );
  }
  return output;
}

async function captureScreenshot(
  win: BrowserWindow,
  options: {
    clip: {
      x: number;
      y: number;
      width: number;
      height: number;
      scale: number;
    };
    format: "png" | "jpeg" | "webp";
    quality?: number;
    timeoutMs: number;
  },
): Promise<string> {
  const result = (await withTimeout(
    win.webContents.debugger.sendCommand("Page.captureScreenshot", {
      format: options.format,
      ...(options.format !== "png" && options.quality !== undefined
        ? { quality: Math.round(options.quality) }
        : {}),
      fromSurface: true,
      captureBeyondViewport: true,
      clip: options.clip,
    }),
    options.timeoutMs,
    "PNG export screenshot capture timeout",
  )) as DevToolsScreenshotResult;
  if (typeof result.data !== "string") {
    throw new Error("DevTools returned an invalid page export screenshot.");
  }
  return result.data;
}
