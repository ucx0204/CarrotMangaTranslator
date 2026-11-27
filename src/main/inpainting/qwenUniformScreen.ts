import type { PixelRect } from "./maskGeometry";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";

const bank = 24;
const margin = 6;

type ReadTone = (x: number, y: number) => number;
type Frame = { left: number; right: number; top: number; bottom: number };

function chooseLine(
  at: ReadTone,
  x: number,
  start: number,
  top: number,
  bottom: number,
) {
  let selected = start + 1;
  let best = Infinity;
  for (let donor = start + 1; donor < start + bank - 1; donor++) {
    let error = 0;
    for (let j = 0; j < bank && error < best; j++) {
      for (let dx = -1; dx <= 1; dx++) {
        error += Math.abs(
          at(x + dx, top - j - 1) - at(donor + dx, top - j - 1),
        );
        error += Math.abs(at(x + dx, bottom + j) - at(donor + dx, bottom + j));
      }
    }
    if (error < best) {
      best = error;
      selected = donor;
    }
  }
  return selected;
}

// Match the phase of each scan line on BOTH sides of the missing rectangle.
// Neither the lettering nor pixels in the validation collar enter the fit.
function matchLines(
  at: (x: number, y: number) => number,
  left: number,
  right: number,
  top: number,
  bottom: number,
) {
  const result = [new Int32Array(right - left), new Int32Array(right - left)];
  for (let x = left; x < right; x++) {
    for (const [side, start] of [left - bank, right].entries()) {
      result[side][x - left] = chooseLine(at, x, start, top, bottom);
    }
  }
  return result;
}

/** Reconstruct a uniform monochrome screen only when four independent print
 * samples agree throughout the hole and predict the untouched perimeter. */
export function restoreUniformQwenScreen(
  original: Buffer,
  stencil: Uint8Array,
  width: number,
  height: number,
  mask: PixelRect | null,
) {
  if (!mask || Math.min(mask.w, mask.h) < 8 || mask.w * mask.h > 240000) return;
  const left = mask.x - margin,
    right = mask.x + mask.w + margin;
  const top = mask.y - margin,
    bottom = mask.y + mask.h + margin;
  if (Math.min(left, top, width - right, height - bottom) < bank) return;
  const at = (x: number, y: number) => original[4 * (y * width + x)];
  const frame = { left, right, top, bottom };
  if (!hasScreenBank(original, width, at, frame)) return;
  const prediction = predictScreen(at, frame);
  if (!prediction) return;
  const w = right - left;
  const ink = dilateBinaryMaskDisk(stencil, width, height, 3);
  if (!survivingPrintMatches(original, prediction, ink, width, frame)) return;
  const result = Buffer.from(original);
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const i = y * width + x;
      if (ink[i])
        result.fill(prediction[(y - top) * w + x - left], 4 * i, 4 * i + 3);
    }
  return result;
}

function hasScreenBank(
  original: Buffer,
  width: number,
  at: ReadTone,
  { left, right, top, bottom }: Frame,
) {
  // Flat paper, colour and transparent plates have other restoration paths.
  let min = 255,
    max = 0;
  for (let y = top - 8; y < top; y++)
    for (let x = left - 8; x < left; x++) {
      const v = at(x, y);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  if (max - min < 45) return false;
  for (let y = top - bank; y < bottom + bank; y++)
    for (let x = left - bank; x < right + bank; x++) {
      const p = 4 * (y * width + x);
      if (
        original[p + 3] !== 255 ||
        original[p] !== original[p + 1] ||
        original[p] !== original[p + 2]
      )
        return false;
    }
  return true;
}

function predictScreen(at: ReadTone, { left, right, top, bottom }: Frame) {
  const [west, east] = matchLines(at, left, right, top, bottom);
  const [north, south] = matchLines(
    (y, x) => at(x, y),
    top,
    bottom,
    left,
    right,
  );
  const w = right - left,
    h = bottom - top;
  const prediction = new Uint8Array(w * h);
  let lowest = 255,
    highest = 0,
    held = 0,
    error = 0,
    outliers = 0;
  function measureTile(x0: number, y0: number) {
    let sum = 0,
      squares = 0,
      disagreement = 0;
    for (let y = y0; y < y0 + 8; y++)
      for (let x = x0; x < x0 + 8; x++) {
        const a = at(west[x], top + y),
          b = at(east[x], top + y);
        const c = at(left + x, north[y]),
          d = at(left + x, south[y]);
        const value = Math.round(
          (a + b + c + d - Math.min(a, b, c, d) - Math.max(a, b, c, d)) / 2,
        );
        prediction[y * w + x] = value;
        sum += value;
        squares += value * value;
        disagreement +=
          Math.abs(a - value) +
          Math.abs(b - value) +
          Math.abs(c - value) +
          Math.abs(d - value);
        if (Math.min(x, y, w - 1 - x, h - 1 - y) < 4) {
          const residual = Math.abs(value - at(left + x, top + y));
          held++;
          error += residual;
          outliers += Number(residual > 40);
        }
      }
    return { sum, squares, disagreement };
  }
  // Overlap the last complete tile so that narrow terminal strips are tested too.
  for (let ty = 0; ty < h; ty += 8)
    for (let tx = 0; tx < w; tx += 8) {
      const x0 = Math.min(tx, w - 8),
        y0 = Math.min(ty, h - 8);
      const { sum, squares, disagreement } = measureTile(x0, y0);
      const mean = sum / 64;
      lowest = Math.min(lowest, mean);
      highest = Math.max(highest, mean);
      if (
        highest - lowest > 22 ||
        squares / 64 - mean * mean < 144 ||
        disagreement > 18 * 256
      )
        return;
    }
  if (error > 12 * held || outliers > 0.012 * held) return;
  return prediction;
}

// Catch an enclosed drawing that does not reach the perimeter. Even a narrow
// surviving pen line between letters disqualifies the uniform-screen route.
function survivingPrintMatches(
  source: Buffer,
  prediction: Uint8Array,
  ink: Uint8Array,
  width: number,
  { left, right, top, bottom }: Frame,
) {
  const w = right - left;
  const counts = new Uint8Array(
    Math.ceil(w / 8) * Math.ceil((bottom - top) / 8),
  );
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const i = y * width + x;
      if (
        ink[i] ||
        Math.abs(source[4 * i] - prediction[(y - top) * w + x - left]) <= 48
      )
        continue;
      const bin =
        Math.floor((y - top) / 8) * Math.ceil(w / 8) +
        Math.floor((x - left) / 8);
      if (++counts[bin] > 8) return false;
    }
  return true;
}
