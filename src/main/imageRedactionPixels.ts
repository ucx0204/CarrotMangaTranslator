import {
  imageRedactionStamps,
  type ImageRedactionStroke,
} from "../shared/imageRedaction";
import {
  PAGE_EXPORT_SOURCE_RASTER_LIMITS,
  validatePageExportRasterSize,
} from "../shared/pageExportLimits";

/** Native-pixel strokes; interpolation prevents gaps when pointer events are sparse. */
export function rasterizeImageRedaction(
  width: number,
  height: number,
  strokes: readonly ImageRedactionStroke[],
): Uint8Array {
  if (
    !validatePageExportRasterSize(
      { width, height },
      PAGE_EXPORT_SOURCE_RASTER_LIMITS,
    ).valid
  )
    throw new Error("가리기 이미지 크기가 지원 범위를 벗어났습니다.");
  const mask = new Uint8Array(width * height);
  const fill = (
    left: number,
    top: number,
    right: number,
    bottom: number,
    round = false,
  ) => {
    const cx = (left + right) / 2,
      cy = (top + bottom) / 2;
    const radius = (right - left) / 2;
    for (
      let y = Math.max(0, Math.floor(top));
      y < Math.min(height, Math.ceil(bottom));
      y++
    )
      for (
        let x = Math.max(0, Math.floor(left));
        x < Math.min(width, Math.ceil(right));
        x++
      )
        if (!round || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius)
          mask[y * width + x] = 255;
  };
  for (const stroke of strokes) {
    const first = stroke.points[0];
    if (!first) continue;
    if (stroke.shape === "rectangle") {
      const last = stroke.points.at(-1) ?? first;
      fill(
        Math.min(first.x, last.x),
        Math.min(first.y, last.y),
        Math.max(first.x, last.x),
        Math.max(first.y, last.y),
      );
      continue;
    }
    const radius = stroke.size / 2;
    for (const { x, y } of imageRedactionStamps(stroke))
      fill(
        x - radius,
        y - radius,
        x + radius,
        y + radius,
        stroke.shape === "round",
      );
  }
  return mask;
}

/** Opaque white; clears every color channel as well as alpha. */
export function flattenImageRedaction(
  bitmap: Buffer,
  mask: Uint8Array,
): Buffer {
  if (bitmap.length !== mask.length * 4)
    throw new Error("가리기 이미지 크기가 다릅니다.");
  const result = Buffer.from(bitmap);
  for (let pixel = 0; pixel < mask.length; pixel++)
    if (mask[pixel]) result.fill(255, pixel * 4, pixel * 4 + 4);
  return result;
}
