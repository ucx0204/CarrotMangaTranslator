import type { BrowserWindow } from "electron";
import type { PageExportRasterSize } from "../shared/pageExportLimits";
import { withTimeout } from "./pageExportLifecycle";
import {
  assertPageExportRasterBudget,
  decodeBoundedPageExportImage,
  decodeBoundedPageExportScreenshot,
} from "./pageExportRasterSafety";

const SCREENSHOT_CAPTURE_TIMEOUT_MS = 30_000;

type DevToolsScreenshotResult = {
  data?: unknown;
};

export type PageExportCaptureOptions = {
  format: "png" | "jpeg" | "webp";
  quality?: number;
};

export async function captureExportPageImage(
  win: BrowserWindow,
  expected: PageExportRasterSize,
  pageName: string,
  options: PageExportCaptureOptions,
  transparentBackground = false,
): Promise<Buffer> {
  assertPageExportRasterBudget(expected, pageName);
  if (transparentBackground && options.format !== "png") {
    throw new Error("Transparent page export requires PNG.");
  }
  if (transparentBackground) {
    await win.webContents.debugger.sendCommand(
      "Emulation.setDefaultBackgroundColorOverride",
      { color: { r: 0, g: 0, b: 0, a: 0 } },
    );
  }
  let result: DevToolsScreenshotResult;
  try {
    result = (await withTimeout(
      win.webContents.debugger.sendCommand("Page.captureScreenshot", {
        format: options.format,
        ...(options.format !== "png" && options.quality !== undefined
          ? { quality: Math.round(options.quality) }
          : {}),
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: expected.width,
          height: expected.height,
          scale: 1,
        },
      }),
      SCREENSHOT_CAPTURE_TIMEOUT_MS,
      "PNG export screenshot capture timeout",
    )) as DevToolsScreenshotResult;
  } finally {
    if (transparentBackground) {
      await win.webContents.debugger.sendCommand(
        "Emulation.setDefaultBackgroundColorOverride",
      );
    }
  }
  if (typeof result.data !== "string") {
    throw new Error("DevTools returned an invalid page export screenshot.");
  }
  return options.format === "png"
    ? decodeBoundedPageExportScreenshot(result.data, expected, pageName)
    : decodeBoundedPageExportImage(
        result.data,
        expected,
        pageName,
        options.format,
      );
}
