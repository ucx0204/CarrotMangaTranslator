import { imageRedactionStamps, type ImageRedactionStroke } from "./imageRedaction";
import { PAGE_EXPORT_SOURCE_RASTER_LIMITS, validatePageExportRasterSize } from "./pageExportLimits";

type MaskTarget = { width: number; height: number; mask: Uint8Array };
type Stamp = { left: number; top: number; right: number; bottom: number; round: boolean };

/** Native-pixel policy shared by transmission and the editor. No image bytes are mutated. */
export function rasterizeImageRedaction(
  width: number,
  height: number,
  strokes: readonly ImageRedactionStroke[],
): Uint8Array {
  if (!validatePageExportRasterSize({ width, height }, PAGE_EXPORT_SOURCE_RASTER_LIMITS).valid)
    throw new Error("가리기 이미지 크기가 지원 범위를 벗어났습니다.");
  const target = { width, height, mask: new Uint8Array(width * height) };
  for (const stroke of strokes) paintStroke(target, stroke);
  return target.mask;
}

function paintStroke(target: MaskTarget, stroke: ImageRedactionStroke): void {
  const first = stroke.points[0];
  if (!first) return;
  const value = stroke.operation === "restore" ? 0 : 255;
  if (stroke.shape === "rectangle") {
    const last = stroke.points.at(-1) ?? first;
    fillStamp(target, {
      left: Math.min(first.x, last.x), top: Math.min(first.y, last.y),
      right: Math.max(first.x, last.x), bottom: Math.max(first.y, last.y), round: false,
    }, value);
    return;
  }
  const radius = stroke.size / 2;
  for (const { x, y } of imageRedactionStamps(stroke))
    fillStamp(target, {
      left: x - radius, top: y - radius, right: x + radius, bottom: y + radius,
      round: stroke.shape === "round",
    }, value);
}

function fillStamp(target: MaskTarget, stamp: Stamp, value: number): void {
  const { left, top, right, bottom, round } = stamp;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const radius = (right - left) / 2;
  for (let y = Math.max(0, Math.floor(top)); y < Math.min(target.height, Math.ceil(bottom)); y++) {
    for (let x = Math.max(0, Math.floor(left)); x < Math.min(target.width, Math.ceil(right)); x++) {
      if (!round || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius)
        target.mask[y * target.width + x] = value;
    }
  }
}
