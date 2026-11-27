import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { PixelRect } from "./maskGeometry";
import { maskComponents } from "./rasterMasks";

type PaperStop = {
  bounds: PixelRect;
  data: Uint8Array;
  pixels: Uint8Array;
  stem: number[];
};
/** Repair a detached dot only after its paired exclamation stroke was removed. */
export function measuredPaperStop(
  bitmap: Buffer,
  stride: number,
  word: PixelRect,
  owner: InpaintingWindowMask,
  text: string,
): PaperStop | undefined {
  if (
    !/[!！]\s*$/u.test(text) ||
    word.h < word.w ||
    word.w < 12 ||
    word.w * word.h > 45000
  )
    return;
  const ink = new Uint8Array(word.w * word.h);
  for (let i = 0; i < ink.length; i++) {
    const at =
      4 * ((word.y + Math.floor(i / word.w)) * stride + word.x + (i % word.w));
    ink[i] = Number(Math.max(bitmap[at], bitmap[at + 1], bitmap[at + 2]) < 138);
  }
  const parts = maskComponents(ink, word.w, word.h, 3);
  for (const dot of parts) {
    const d = dot.rect;
    if (!isTerminalDot(d, word)) continue;
    const stem = parts.find(
      ({ rect: r }) =>
        r.h >= 2.5 * d.h &&
        r.h <= 8 * d.h &&
        r.w <= 4 * d.w &&
        r.y + r.h <= d.y &&
        d.y - r.y - r.h < 2.8 * d.h &&
        Math.abs(r.x + r.w / 2 - (d.x + d.w / 2)) < 1.9 * d.w,
    );
    if (!stem) continue;
    const points = Array.from(stem.data, (on, i) =>
      on
        ? (word.y + stem.rect.y + Math.floor(i / stem.rect.w)) * stride +
          word.x +
          stem.rect.x +
          (i % stem.rect.w)
        : -1,
    ).filter((i) => i >= 0);
    const patch = sampleStop(
      bitmap,
      stride,
      { ...d, x: word.x + d.x, y: word.y + d.y },
      owner,
      points,
    );
    if (patch) return patch;
  }
}

function sampleStop(
  bitmap: Buffer,
  stride: number,
  d: PixelRect,
  owner: InpaintingWindowMask,
  stem: number[],
) {
  const bounds = { x: d.x - 2, y: d.y - 2, w: d.w + 4, h: d.h + 4 },
    o = owner.bounds;
  if (
    bounds.x < 1 ||
    bounds.y < 1 ||
    bounds.x + bounds.w >= stride ||
    bounds.y + bounds.h >= bitmap.length / (4 * stride)
  )
    return;
  const colour = paperAroundStop(bitmap, stride, bounds);
  if (!colour) return;
  const data = new Uint8Array(bounds.w * bounds.h),
    pixels = new Uint8Array(3 * data.length);
  for (let i = 0; i < data.length; i++) {
    const x = bounds.x + (i % bounds.w),
      y = bounds.y + Math.floor(i / bounds.w);
    if (
      x < o.x ||
      y < o.y ||
      x >= o.x + o.w ||
      y >= o.y + o.h ||
      !owner.data[(y - o.y) * o.w + x - o.x]
    )
      continue;
    data[i] = 1;
    pixels.set(colour, 3 * i);
  }
  return { bounds, data, pixels, stem };
}

export function finishPaperStop(
  patch: PaperStop,
  bitmap: Buffer,
  stride: number,
) {
  const bright = patch.stem.filter((i) => bitmap[4 * i + 1] > 200).length;
  if (bright < 0.88 * patch.stem.length) return;
  const { bounds, data, pixels } = patch;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const at =
      4 *
      ((bounds.y + Math.floor(i / bounds.w)) * stride +
        bounds.x +
        (i % bounds.w));
    if (bitmap[at + 1] >= pixels[3 * i + 1] - 6) continue;
    for (let k = 0; k < 3; k++) bitmap[at + k] = pixels[3 * i + k];
  }
}

function isTerminalDot(d: PixelRect, word: PixelRect) {
  return (
    d.y >= word.h * 0.65 &&
    Math.max(d.w, d.h) <= 7 &&
    Math.max(d.w, d.h) <= 1.75 * Math.min(d.w, d.h)
  );
}

function paperAroundStop(bitmap: Buffer, stride: number, bounds: PixelRect) {
  const channel: number[][] = [[], [], []];
  for (let y = -1; y <= bounds.h; y++)
    for (let x = -1; x <= bounds.w; x++) {
      if (x >= 0 && y >= 0 && x < bounds.w && y < bounds.h) continue;
      const at = 4 * ((bounds.y + y) * stride + bounds.x + x);
      channel.forEach((values, k) => values.push(bitmap[at + k]));
    }
  const paper = channel.map((values) => values.sort((a, b) => a - b));
  if (
    paper.some(
      (v) =>
        v[Math.floor(v.length * 0.15)] < 185 ||
        v[Math.ceil(v.length * 0.85)] - v[Math.floor(v.length * 0.15)] > 26,
    )
  )
    return;
  return paper.map((v) => v[v.length >> 1]);
}
