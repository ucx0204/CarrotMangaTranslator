import type { ImageRedactionStroke } from "../shared/imageRedaction";
import { rasterizeImageRedaction as rasterizeMask } from "../shared/imageRedactionRaster";

/** Existing native adapter API; the pixel policy is shared with the manual editor. */
export function rasterizeImageRedaction(
  width: number,
  height: number,
  strokes: readonly ImageRedactionStroke[],
): Uint8Array {
  return rasterizeMask(width, height, strokes);
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

/** Restore excluded native pixels after compositing; generated neighbors stay intact. */
export function restoreHiddenPixels(
  original: Buffer,
  working: Buffer,
  hidden?: Uint8Array,
): void {
  if (!hidden) return;
  for (let pixel = 0; pixel < hidden.length; pixel++)
    if (hidden[pixel])
      original.copy(working, pixel * 4, pixel * 4, pixel * 4 + 4);
}
