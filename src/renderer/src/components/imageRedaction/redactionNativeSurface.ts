import type { RedactionPreviewRegion } from "../../../../shared/imageRedactionPreview";
import { redactionPreviewVariantKey } from "../../../../shared/imageRedactionPreview";
import type { RedactionPreviewSource } from "./redactionWorkspaceTypes";
import type { RedactionMaskWindow } from "./redactionMaskWindow";

type Page = { id: string; width: number; height: number };
export function nativeRedactionPreviewKey(
  cache: RedactionPreviewSource,
  sessionId: string,
  page: Page,
  window: RedactionMaskWindow,
  zoom: number,
): string {
  if (zoom < 100 || Math.max(page.width, page.height) <= 2048) return "";
  return `${sessionId}:${page.id}:${cache.version(sessionId, page.id)}:${redactionPreviewVariantKey(2048, window)}`;
}

/** Tiles cover only the visible inspection area, without upscaling an overview. */
export function nativeRedactionPreviewTiles(
  region: RedactionPreviewRegion,
): RedactionPreviewRegion[] {
  const tiles: RedactionPreviewRegion[] = [];
  for (let y = region.y; y < region.y + region.height; y += 2048)
    for (let x = region.x; x < region.x + region.width; x += 2048)
      tiles.push({
        x,
        y,
        width: Math.min(2048, region.x + region.width - x),
        height: Math.min(2048, region.y + region.height - y),
      });
  return tiles;
}

export async function renderNativeRedactionPreview(
  cache: RedactionPreviewSource,
  sessionId: string,
  pageId: string,
  region: RedactionPreviewRegion,
  signal: AbortSignal,
): Promise<HTMLCanvasElement> {
  signal.throwIfAborted();
  const target = document.createElement("canvas");
  target.width = region.width;
  target.height = region.height;
  const context = target.getContext("2d");
  if (!context) throw new Error("The native preview canvas is unavailable");
  for (const tile of nativeRedactionPreviewTiles(region)) {
    signal.throwIfAborted();
    const url = await cache.read(
      { sessionId, pageId, maxEdge: 2048, region: tile },
      true,
    );
    const image = await decodeNativePreview(url, signal);
    signal.throwIfAborted();
    if (
      image.naturalWidth !== tile.width ||
      image.naturalHeight !== tile.height
    )
      throw new Error("The native preview tile has an unexpected size");
    context.drawImage(image, tile.x - region.x, tile.y - region.y);
  }
  signal.throwIfAborted();
  return target;
}

function decodeNativePreview(
  url: string,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (error?: unknown) => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
      if (error) {
        image.src = "";
        reject(error);
      } else resolve(image);
    };
    const abort = () => finish(signal.reason ?? new Error("Preview cancelled"));
    image.onload = () => finish();
    image.onerror = () =>
      finish(new Error("The native preview image could not be decoded"));
    signal.addEventListener("abort", abort, { once: true });
    image.src = url;
  });
}
