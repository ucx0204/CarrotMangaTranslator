import type { MangaPage } from "../shared/libraryTypes";
import type { FontMatchingRasterPage } from "./pipeline/fontMatchingPagePixelPreprocessing";

/**
 * Load the immutable original page as Electron's native BGRA bitmap.
 *
 * electron is required lazily inside this function because this module is
 * imported transitively by the font matching worker_threads worker (via
 * fontMatchingPagePixelInference). The worker never calls this function (the
 * main process decodes the raster and transfers the BGRA buffer), and a
 * worker_threads worker has no electron module — a top-level import would make
 * the worker fail to spawn with "Cannot find module 'electron'", silently
 * disabling font matching. Only the main process reaches this call.
 */
export async function loadFontMatchingPageRaster(
  page: MangaPage,
  signal?: AbortSignal,
): Promise<FontMatchingRasterPage> {
  throwIfAborted(signal);
  const { nativeImage } = require("electron") as typeof import("electron");
  const image = nativeImage.createFromPath(page.imagePath);
  if (image.isEmpty()) {
    throw new Error("Font matching could not decode the original page image.");
  }
  const size = image.getSize();
  const bitmap = image.toBitmap();
  throwIfAborted(signal);
  return {
    width: size.width,
    height: size.height,
    bgra: Uint8Array.from(bitmap),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
