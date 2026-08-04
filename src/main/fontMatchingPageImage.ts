import { nativeImage } from "electron";
import type { MangaPage } from "../shared/libraryTypes";
import type { FontMatchingRasterPage } from "./pipeline/fontMatchingPagePixelPreprocessing";

/** Load the immutable original page as Electron's native BGRA bitmap. */
export async function loadFontMatchingPageRaster(
  page: MangaPage,
  signal?: AbortSignal,
): Promise<FontMatchingRasterPage> {
  throwIfAborted(signal);
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
