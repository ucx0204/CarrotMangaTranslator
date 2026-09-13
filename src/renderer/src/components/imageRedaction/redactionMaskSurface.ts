import type { ImageRedactionStroke } from "../../../../shared/imageRedaction";
import { redactionStrokeBounds } from "../../../../shared/imageRedactionEditing";
import {
  rasterizeImageRedactionRegion,
  type RedactionRasterRegion,
} from "../../../../shared/imageRedactionRaster";
import {
  sameRedactionMaskWindow,
  type RedactionMaskWindow,
} from "./redactionMaskWindow";

export type RedactionMaskSurface = {
  canvas: HTMLCanvasElement;
  window: RedactionMaskWindow;
  strokes: ImageRedactionStroke[];
};

/** Native tiles are reduced only for display; neither originals nor transmitted masks change. */
export async function renderRedactionMaskSurface(
  page: { width: number; height: number },
  window: RedactionMaskWindow,
  strokes: ImageRedactionStroke[],
  signal: AbortSignal,
  previous?: RedactionMaskSurface,
): Promise<RedactionMaskSurface> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(window.width / window.factor);
  canvas.height = Math.ceil(window.height / window.factor);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The mask canvas is unavailable");
  const reusable = previous && sameRedactionMaskWindow(previous.window, window);
  if (reusable) context.drawImage(previous.canvas, 0, 0);
  const dirty = reusable
    ? changedMaskBounds(previous.strokes, strokes, window)
    : changedMaskBounds([], strokes, window);
  if (strokes.length || reusable)
    await paintTiles(context, page, window, dirty, strokes, signal);
  signal.throwIfAborted();
  return { canvas, window, strokes };
}

async function paintTiles(
  context: CanvasRenderingContext2D,
  page: { width: number; height: number },
  window: RedactionMaskWindow,
  dirty: RedactionRasterRegion,
  strokes: ImageRedactionStroke[],
  signal: AbortSignal,
): Promise<void> {
  const scratch = document.createElement("canvas");
  const factor = window.factor;
  const left = Math.max(window.x, Math.floor(dirty.x / factor) * factor);
  const top = Math.max(window.y, Math.floor(dirty.y / factor) * factor);
  const right = Math.min(
    window.x + window.width,
    Math.ceil((dirty.x + dirty.width) / factor) * factor,
  );
  const bottom = Math.min(
    window.y + window.height,
    Math.ceil((dirty.y + dirty.height) / factor) * factor,
  );
  let slice = performance.now();
  for (let y = top; y < bottom; y += 512)
    for (let x = left; x < right; x += 512) {
      signal.throwIfAborted();
      const region = {
        x,
        y,
        width: Math.min(512, right - x),
        height: Math.min(512, bottom - y),
      };
      drawMaskTile(context, scratch, page, window, region, strokes);
      if (performance.now() - slice > 8) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        slice = performance.now();
      }
    }
}

function drawMaskTile(
  context: CanvasRenderingContext2D,
  scratch: HTMLCanvasElement,
  page: { width: number; height: number },
  window: RedactionMaskWindow,
  region: RedactionRasterRegion,
  strokes: ImageRedactionStroke[],
): void {
  scratch.width = region.width;
  scratch.height = region.height;
  const target = scratch.getContext("2d");
  if (!target) throw new Error("The mask canvas is unavailable");
  const mask = rasterizeImageRedactionRegion(
    page.width,
    page.height,
    strokes,
    region,
  );
  const image = target.createImageData(region.width, region.height);
  for (let pixel = 0; pixel < mask.length; pixel++)
    if (mask[pixel]) image.data.fill(255, pixel * 4, pixel * 4 + 4);
  target.putImageData(image, 0, 0);
  const x = (region.x - window.x) / window.factor;
  const y = (region.y - window.y) / window.factor;
  const width = region.width / window.factor;
  const height = region.height / window.factor;
  context.clearRect(x, y, width, height);
  context.drawImage(scratch, x, y, width, height);
}

/** Appends and geometry edits are local; regrouping/deletion conservatively repaints. */
function changedMaskBounds(
  before: ImageRedactionStroke[],
  after: ImageRedactionStroke[],
  fallback: RedactionRasterRegion,
): RedactionRasterRegion {
  let changes: ImageRedactionStroke[];
  if (
    before.length <= after.length &&
    before.every((stroke, index) => stroke === after[index])
  ) {
    changes = after.slice(before.length);
  } else if (
    before.length === after.length &&
    before.every(
      (stroke, index) =>
        JSON.stringify(stroke.isolation) ===
        JSON.stringify(after[index].isolation),
    )
  ) {
    changes = before.flatMap((stroke, index) =>
      stroke === after[index] ? [] : [stroke, after[index]],
    );
  } else return fallback;
  if (!changes.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const stroke of changes) {
    const bounds = redactionStrokeBounds(stroke);
    x = Math.min(x, bounds.x);
    y = Math.min(y, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}
