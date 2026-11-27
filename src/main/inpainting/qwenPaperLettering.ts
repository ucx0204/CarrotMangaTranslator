import type { PixelRect } from "./maskGeometry";
import { maskComponents } from "./rasterMasks";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";

type LocalPaper = {
  bitmap: Buffer;
  width: number;
  bounds: PixelRect;
  selection: PixelRect;
};
function sourceIndex(input: LocalPaper, i: number) {
  return (
    4 *
    ((input.bounds.y + Math.floor(i / input.bounds.w)) * input.width +
      input.bounds.x +
      (i % input.bounds.w))
  );
}

// Lettercolour is independent evidence on promotional pages where the
// monochrome layout model includes only the black half of a two-colour reading.
export function measurePaperLettering(input: LocalPaper) {
  const { bitmap, bounds, selection } = input;
  if (selection.h < 1.4 * selection.w || bounds.w * bounds.h > 220000) return;
  const size = bounds.w * bounds.h,
    red = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const at = sourceIndex(input, i),
      r = bitmap[at + 2],
      g = bitmap[at + 1],
      b = bitmap[at];
    red[i] = Number(r - g > 34 && r - b > 27 && g < 198);
  }
  const data = new Uint8Array(size),
    pixels = new Uint8Array(3 * size);
  let printed = 0;
  for (const part of maskComponents(red, bounds.w, bounds.h, 1)) {
    if (!isLetterPiece(part, bounds, selection)) continue;
    const colour = surroundingPaper(input, part.rect, red);
    if (!colour) continue;
    colourPiece(input, part, colour, { data, pixels });
    printed += part.area;
  }
  if (printed < Math.max(24, 0.016 * selection.w * selection.h)) return;
  return { bounds, data, pixels };
}

type Piece = ReturnType<typeof maskComponents>[number];
function isLetterPiece(part: Piece, bounds: PixelRect, selection: PixelRect) {
  const r = part.rect;
  return (
    part.area >= 5 &&
    r.w >= 2 &&
    r.h >= 3 &&
    r.w <= selection.w + 2 &&
    r.h <= 1.65 * selection.w &&
    withinReading(r, bounds, selection)
  );
}
function colourPiece(
  input: LocalPaper,
  part: Piece,
  colour: number[],
  out: { data: Uint8Array; pixels: Uint8Array },
) {
  const { bounds, bitmap } = input,
    { data, pixels } = out,
    r = part.rect;
  const support = dilateLocalPart(part.data, r, bounds);
  for (let y = 0; y < support.h; y++)
    for (let x = 0; x < support.w; x++) {
      if (!support.data[y * support.w + x]) continue;
      const local = (support.y + y) * bounds.w + support.x + x,
        src = sourceIndex(input, local);
      // Neutral pen crossing a red character is spatially independent.
      const chroma = bitmap[src + 2] - Math.min(bitmap[src], bitmap[src + 1]);
      if (
        chroma < 5 &&
        Math.min(bitmap[src], bitmap[src + 1], bitmap[src + 2]) < 190
      )
        continue;
      data[local] = 1;
      pixels.set(colour, 3 * local);
    }
}

function withinReading(r: PixelRect, b: PixelRect, word: PixelRect) {
  return (
    r.x > 1 &&
    r.y > 1 &&
    r.x + r.w < b.w - 1 &&
    r.y + r.h < b.h - 1 &&
    r.x + b.x >= word.x - 3 &&
    r.y + b.y >= word.y - 3 &&
    r.x + b.x + r.w <= word.x + word.w + 3 &&
    r.y + b.y + r.h <= word.y + word.h + 3
  );
}

function surroundingPaper(input: LocalPaper, r: PixelRect, ink: Uint8Array) {
  const channels: number[][] = [[], [], []],
    { bounds, bitmap } = input;
  let samples = 0;
  for (let y = Math.max(0, r.y - 4); y < Math.min(bounds.h, r.y + r.h + 4); y++)
    for (
      let x = Math.max(0, r.x - 4);
      x < Math.min(bounds.w, r.x + r.w + 4);
      x++
    ) {
      if (
        x >= r.x - 1 &&
        x < r.x + r.w + 1 &&
        y >= r.y - 1 &&
        y < r.y + r.h + 1
      )
        continue;
      const i = y * bounds.w + x,
        at = sourceIndex(input, i);
      samples++;
      if (ink[i] || Math.min(bitmap[at], bitmap[at + 1], bitmap[at + 2]) < 180)
        continue;
      channels.forEach((c, k) => c.push(bitmap[at + k]));
    }
  if (channels[0].length < Math.max(12, 0.68 * samples)) return;
  const colour: number[] = [];
  for (const c of channels) {
    c.sort((a, b) => a - b);
    if (c[Math.floor(0.8 * c.length)] - c[Math.floor(0.2 * c.length)] > 27)
      return;
    colour.push(c[c.length >> 1]);
  }
  return colour;
}
function dilateLocalPart(ink: Uint8Array, r: PixelRect, frame: PixelRect) {
  const x = Math.max(0, r.x - 3),
    y = Math.max(0, r.y - 3),
    w = Math.min(frame.w, r.x + r.w + 3) - x,
    h = Math.min(frame.h, r.y + r.h + 3) - y;
  const data = new Uint8Array(w * h);
  for (let row = 0; row < r.h; row++)
    data.set(
      ink.subarray(row * r.w, (row + 1) * r.w),
      (row + r.y - y) * w + r.x - x,
    );
  return { x, y, w, h, data: dilateBinaryMaskDisk(data, w, h, 3) };
}

export function finishPaperLettering(
  patch: { bounds: PixelRect; data: Uint8Array; pixels: Uint8Array },
  bitmap: Buffer,
  stride: number,
) {
  const { bounds, data, pixels } = patch;
  const residual = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const at =
      4 *
      ((bounds.y + Math.floor(i / bounds.w)) * stride +
        bounds.x +
        (i % bounds.w));
    residual[i] = Number(
      bitmap[at + 2] - Math.min(bitmap[at], bitmap[at + 1]) > 15,
    );
  }
  const rim = dilateBinaryMaskDisk(residual, bounds.w, bounds.h, 3);
  for (let i = 0; i < data.length; i++) {
    if (!(rim[i] && data[i])) continue;
    const at =
      4 *
      ((bounds.y + Math.floor(i / bounds.w)) * stride +
        bounds.x +
        (i % bounds.w));
    for (let channel = 0; channel < 3; channel++)
      bitmap[at + channel] = pixels[3 * i + channel];
  }
}
