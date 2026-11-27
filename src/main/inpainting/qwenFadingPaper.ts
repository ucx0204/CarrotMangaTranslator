import type { PixelRect } from "./maskGeometry";

type PaperCrop = {
  original: Buffer;
  inkBounds: PixelRect | null;
  width: number;
  height: number;
};
function strip(
  bytes: Buffer,
  width: number,
  y: number,
  left: number,
  right: number,
  chromaTolerance = 4,
) {
  const values: number[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let x = left; x < right; x += 2) {
      const at = 4 * ((y + dy) * width + x),
        g = bytes[at + 1];
      if (
        Math.max(Math.abs(bytes[at] - g), Math.abs(bytes[at + 2] - g)) >
        chromaTolerance
      )
        return;
      values.push(g);
    }
  values.sort((a, b) => a - b);
  return [0.05, 0.25, 0.5, 0.75].map(
    (q) => values[Math.floor(q * values.length)],
  );
}
function rowMatches(left: number[], right: number[], native: number[]) {
  return native.every(
    (v, k) =>
      v >= Math.min(left[k], right[k]) - 12 &&
      v <= Math.max(left[k], right[k]) + 14,
  );
}
/** Compare a native reconstruction with exposed rows down both sides of a fading
 * monochrome plate. A dark stroke in either the reconstructed core or the clean
 * outside bank disqualifies a row. Neither paper stock nor hatch density is guessed. */
export function agreesWithFadingPaper(crop: PaperCrop, pixels: Buffer) {
  const { original, inkBounds: b, width, height } = crop;
  if (
    !b ||
    b.h < 40 ||
    b.y < 2 ||
    b.y + b.h + 1 >= height ||
    b.x < 20 ||
    b.x + b.w + 20 >= width
  )
    return false;
  let rows = 0,
    matched = 0,
    clean = 0;
  const predicted: number[] = [],
    leftLevels: number[] = [],
    rightLevels: number[] = [];
  const step = Math.max(2, Math.floor(b.h / 46));
  for (let y = b.y + 1; y < b.y + b.h - 1; y += step) {
    const l = strip(original, width, y, b.x - 20, b.x - 3),
      r = strip(original, width, y, b.x + b.w + 3, b.x + b.w + 20);
    const pred = strip(pixels, width, y, b.x, b.x + b.w, 10);
    if (!l || !r || !pred) return false;
    rows++;
    predicted.push(pred[2]);
    leftLevels.push(l[2]);
    rightLevels.push(r[2]);
    matched += Number(rowMatches(l, r, pred));
    clean += Number(Math.max(l[0], r[0]) > 85 && pred[0] > 75);
  }
  return matchesGradedStock(
    leftLevels,
    rightLevels,
    predicted,
    matched / rows,
    clean / rows,
    b,
  );
}
function matchesGradedStock(
  left: number[],
  right: number[],
  predicted: number[],
  matched: number,
  clean: number,
  b: PixelRect,
) {
  if (clean < 0.93) return false;
  const a = fadeLevels(left),
    c = fadeLevels(right);
  if (!a.steady || !c.steady || a.change * c.change <= 0) return false;
  if (matched >= 0.91 && Math.min(Math.abs(a.change), Math.abs(c.change)) >= 24)
    return true;
  return (
    matched >= 0.79 &&
    clean >= 0.99 &&
    Math.min(b.w, b.h) >= 100 &&
    Math.min(a.end, c.end) >= 250 &&
    Math.max(a.change, c.change) >= 55 &&
    corroboratedFade(predicted)
  );
}
function fadeLevels(levels: number[]) {
  const span = Math.max(3, Math.floor(levels.length / 6));
  const middle = (s: number[]) => s.sort((a, b) => a - b)[s.length >> 1];
  const start = middle(levels.slice(0, span)),
    end = middle(levels.slice(-span));
  const direction = Math.sign(end - start);
  const steady =
    levels.filter((v, i) => !i || direction * (v - levels[i - 1]) >= -18)
      .length >=
    0.9 * levels.length;
  return { change: end - start, end, steady };
}

function corroboratedFade(predicted: number[]) {
  const f = fadeLevels(predicted);
  return f.steady && f.change >= 38 && f.end >= 248;
}
