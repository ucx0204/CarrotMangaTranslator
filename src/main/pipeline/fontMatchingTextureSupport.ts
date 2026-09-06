import type { BBox } from "../../shared/textTypes";
import {
  prepareFontMatchingInkComponents,
  type FontMatchingRasterPage,
} from "./fontMatchingPagePixelPreprocessing";
import { selectFontExpressionComponents } from "./fontMatchingExpressionSupport";

export const FONT_TEXTURE_PATCH_SIZE = 96;

/** Frozen S18 intact texture input. PIL grayscale, OpenCV affine, uint8 ties-to-even. */
export function prepareFontTextureSupport(
  page: FontMatchingRasterPage,
  bbox: BBox,
  signal?: AbortSignal,
) {
  const ink = prepareFontMatchingInkComponents(page, bbox, signal, "pil");
  if (!ink) return null;
  const components = selectFontExpressionComponents(ink).slice(0, 8);
  if (!components.length) return null;
  const extents = components
    .map((c) => Math.max(c.x2 - c.x1, c.y2 - c.y1))
    .sort((a, b) => a - b);
  const middle = Math.floor(extents.length / 2);
  const extent =
    extents.length % 2
      ? extents[middle]
      : (extents[middle - 1] + extents[middle]) / 2;
  const scale = Math.fround(96 / Math.max(8, extent * 2));
  const values = new Float32Array(components.length * 96 * 96);
  const source = Float32Array.from(ink.grayscale, (v) => {
    const dark = Math.fround(1 - Math.fround(v / 255));
    return ink.foregroundPolarity === "dark" ? dark : Math.fround(1 - dark);
  });
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= ink.width || y >= ink.height
      ? 0
      : source[y * ink.width + x];
  for (const [index, c] of components.entries()) {
    signal?.throwIfAborted();
    // OpenCV receives a float32 forward matrix, then inverts in float64.
    const tx = Math.fround(
      47.5 - (96 / Math.max(8, extent * 2)) * ((c.x1 + c.x2) / 2 - 0.5),
    );
    const ty = Math.fround(
      47.5 - (96 / Math.max(8, extent * 2)) * ((c.y1 + c.y2) / 2 - 0.5),
    );
    for (let y = 0; y < 96; y++)
      for (let x = 0; x < 96; x++) {
        const fx =
          (roundEven((x / scale) * 1024) +
            roundEven((-tx / scale) * 1024) +
            16) >>
          5;
        const fy = (roundEven((y / scale - ty / scale) * 1024) + 16) >> 5;
        const sx = fx >> 5,
          sy = fy >> 5,
          dx = (fx & 31) / 32,
          dy = (fy & 31) / 32;
        const p = Math.fround(
          Math.fround(
            Math.fround(
              Math.fround(at(sx, sy) * (1 - dx) * (1 - dy)) +
                Math.fround(at(sx + 1, sy) * dx * (1 - dy)),
            ) + Math.fround(at(sx, sy + 1) * (1 - dx) * dy),
          ) + Math.fround(at(sx + 1, sy + 1) * dx * dy),
        );
        values[index * 96 * 96 + y * 96 + x] =
          roundEven(Math.fround(p * 255)) / 255;
      }
  }
  return { values, count: components.length, threshold: ink.threshold };
}

function roundEven(value: number) {
  const floor = Math.floor(value);
  return value - floor === 0.5
    ? floor + (floor % 2 === 0 ? 0 : 1)
    : Math.round(value);
}
