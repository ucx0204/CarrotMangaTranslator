import {
  imageRedactionStamps,
  MAX_REDACTION_ISOLATION_DEPTH,
  type ImageRedactionStroke,
} from "./imageRedaction";
import { assertSupportedRedactionSize } from "./imageRedactionLimits";

export type RedactionRasterRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export const REDACTION_RASTER_TILE_SIZE = 512;
type MaskTarget = RedactionRasterRegion & { mask: Uint8Array };
type Stamp = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  round: boolean;
};

/** Native-pixel policy shared by transmission and the editor. No image bytes are mutated. */
export function rasterizeImageRedaction(
  width: number,
  height: number,
  strokes: readonly ImageRedactionStroke[],
): Uint8Array {
  assertSupportedRedactionSize({ width, height });
  return rasterizeRegion({ x: 0, y: 0, width, height }, strokes);
}

/** A bounded native-pixel tile, exactly equivalent to cropping the full mask. */
export function rasterizeImageRedactionRegion(
  width: number,
  height: number,
  strokes: readonly ImageRedactionStroke[],
  region: RedactionRasterRegion,
): Uint8Array {
  assertSupportedRedactionSize({ width, height });
  if (
    ![region.x, region.y, region.width, region.height].every(
      Number.isSafeInteger,
    ) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.width > REDACTION_RASTER_TILE_SIZE ||
    region.height > REDACTION_RASTER_TILE_SIZE ||
    region.x + region.width > width ||
    region.y + region.height > height
  )
    throw new Error("Invalid redaction raster tile");
  return rasterizeRegion(region, strokes);
}

function rasterizeRegion(
  region: RedactionRasterRegion,
  strokes: readonly ImageRedactionStroke[],
): Uint8Array {
  const target = {
    ...region,
    mask: new Uint8Array(region.width * region.height),
  };
  paintSequence(target, strokes, 0, strokes.length, 0);
  return target.mask;
}

function paintSequence(
  target: MaskTarget,
  strokes: readonly ImageRedactionStroke[],
  start: number,
  end: number,
  depth: number,
): void {
  for (let index = start; index < end; ) {
    const group = strokes[index].isolation?.[depth];
    if (group === undefined) {
      paintStroke(target, strokes[index++]);
      continue;
    }
    if (depth >= MAX_REDACTION_ISOLATION_DEPTH)
      throw new Error("The nested mask copy limit was exceeded");
    let limit = index + 1;
    while (limit < end && strokes[limit].isolation?.[depth] === group) limit++;
    const layer = { ...target, mask: new Uint8Array(target.mask.length) };
    paintSequence(layer, strokes, index, limit, depth + 1);
    for (let pixel = 0; pixel < target.mask.length; pixel++)
      if (layer.mask[pixel]) target.mask[pixel] = 255;
    index = limit;
  }
}

function paintStroke(target: MaskTarget, stroke: ImageRedactionStroke): void {
  const first = stroke.points[0];
  if (!first) return;
  const value = stroke.operation === "restore" ? 0 : 255;
  if (stroke.shape === "rectangle") {
    const last = stroke.points.at(-1) ?? first;
    fillStamp(
      target,
      {
        left: Math.min(first.x, last.x),
        top: Math.min(first.y, last.y),
        right: Math.max(first.x, last.x),
        bottom: Math.max(first.y, last.y),
        round: false,
      },
      value,
    );
    return;
  }
  const radius = stroke.size / 2;
  for (const { x, y } of imageRedactionStamps(stroke))
    fillStamp(
      target,
      {
        left: x - radius,
        top: y - radius,
        right: x + radius,
        bottom: y + radius,
        round: stroke.shape === "round",
      },
      value,
    );
}

function fillStamp(target: MaskTarget, stamp: Stamp, value: number): void {
  const { left, top, right, bottom, round } = stamp;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const radius = (right - left) / 2;
  for (
    let y = Math.max(target.y, Math.floor(top));
    y < Math.min(target.y + target.height, Math.ceil(bottom));
    y++
  ) {
    for (
      let x = Math.max(target.x, Math.floor(left));
      x < Math.min(target.x + target.width, Math.ceil(right));
      x++
    ) {
      if (!round || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius)
        target.mask[(y - target.y) * target.width + x - target.x] = value;
    }
  }
}
