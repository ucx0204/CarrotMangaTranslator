import { printMaskGrid } from "./qwenPrintedPigment";
import type { PixelRect } from "./maskGeometry";

const white = 24,
  plain = 25;

export function darkTitleColour(
  bitmap: Buffer,
  stride: number,
  bounds: PixelRect,
  selected: PixelRect,
) {
  const w = bounds.w,
    h = bounds.h,
    tones = new Uint8Array(w * h),
    pale = new Uint8Array(w * h);
  const dark = new Uint8Array(w * h),
    colour = new Uint8Array(w * h),
    region = new Uint8Array(w * h);
  for (let i = 0; i < tones.length; i++) {
    const x = bounds.x + (i % w),
      y = bounds.y + Math.floor(i / w),
      k = 4 * (y * stride + x);
    const b = bitmap[k],
      g = bitmap[k + 1],
      r = bitmap[k + 2],
      high = Math.max(r, g, b),
      low = Math.min(r, g, b);
    tones[i] = pigment(b, g, r);
    pale[i] = Number(low > 230 && high - low < 30);
    dark[i] = Number(high < 158 && high - low > 23);
    colour[i] = Number(high - low > 44);
    region[i] = Number(withinTitleRow(x, y, selected));
  }
  const toWhite = printMaskGrid(w, h).distance(pale),
    hist = new Uint32Array(24);
  for (let i = 0; i < dark.length; i++)
    if (region[i] && dark[i] && toWhite[i] <= 4.6 && tones[i] < 24)
      hist[tones[i]]++;
  const n = hist.reduce((a, b) => a + b, 0),
    peak = hist.indexOf(Math.max(...hist));
  if (n < 85 || tally(hist, peak) < 0.67 * n) return;
  const family = dark.map((v, i) =>
    Number(
      v &&
        region[i] &&
        tones[i] < 24 &&
        Math.min((tones[i] - peak + 24) % 24, (peak - tones[i] + 24) % 24) <= 2,
    ),
  );
  return { family, pale, colour, toWhite, region };
}
function withinTitleRow(x: number, y: number, rect: PixelRect) {
  return (
    x >= rect.x - 2 &&
    y >= rect.y - 2 &&
    x < rect.x + rect.w + 2 &&
    y < rect.y + rect.h + 2
  );
}
// Neighbouring sectors absorb small hue changes caused by compositing
// translucent ink over different underlying illustrations.
function pigment(b: number, g: number, r: number) {
  const high = Math.max(r, g, b),
    low = Math.min(r, g, b),
    span = high - low;
  if (span < 34) return low > 219 ? white : plain;
  const turn =
    high === r
      ? (g - b) / span
      : high === g
        ? 2 + (b - r) / span
        : 4 + (r - g) / span;
  return (Math.round(4 * turn) + 24) % 24;
}
function tally(hist: Uint32Array, channel: number) {
  if (channel >= 24) return hist[channel];
  return hist[(channel + 23) % 24] + hist[channel] + hist[(channel + 1) % 24];
}

function classify(banks: Uint32Array[], sizes: Uint32Array) {
  if (Math.min(...sizes) < 48) return;
  const freq = (bank: number, col: number) =>
    tally(banks[bank], col) / sizes[bank];
  for (let c = 0; c < 24; c++) {
    if (
      freq(0, white) > 0.23 &&
      freq(1, c) > 0.64 &&
      freq(1, c) - freq(3, c) > 0.46 &&
      freq(2, c) - freq(3, c) > 0.13
    )
      return { ring: c, core: white };
    if (
      freq(0, c) > 0.68 &&
      freq(0, c) - freq(3, c) > 0.46 &&
      freq(1, white) > 0.61 &&
      freq(1, white) - freq(3, white) > 0.35
    )
      return { ring: white, core: c };
  }
}

function inColour(got: number, want: number) {
  if (want === white) return got === white;
  return (
    got < 24 && Math.min((got - want + 24) % 24, (want - got + 24) % 24) <= 1
  );
}

/** Measure a repeated opaque face and contrasting luminous rim directly
 * around the selected characters. Require the same pair in separate parts
 * of the row before claiming either the colour or the printable envelope. */
export function printedColourHalo(
  bitmap: Buffer,
  stride: number,
  bounds: PixelRect,
  ink: Uint8Array,
) {
  const { w, h } = bounds;
  const grid = printMaskGrid(w, h),
    d = grid.distance(ink);
  const colours = new Uint8Array(ink.length);
  const banks = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => new Uint32Array(26)),
  );
  const counts = Array.from({ length: 4 }, () => new Uint32Array(4));
  for (let i = 0; i < d.length; i++) {
    const x = i % w,
      y = Math.floor(i / w),
      p = 4 * ((bounds.y + y) * stride + bounds.x + x);
    const v = pigment(bitmap[p], bitmap[p + 1], bitmap[p + 2]);
    colours[i] = v;
    const z =
      d[i] === 0
        ? 0
        : d[i] < 6
          ? 1
          : d[i] < 14
            ? 2
            : d[i] >= 23 && d[i] < 38
              ? 3
              : -1;
    if (z < 0) continue;
    const part = 1 + Math.min(2, Math.floor((3 * x) / w));
    banks[0][z][v]++;
    counts[0][z]++;
    banks[part][z][v]++;
    counts[part][z]++;
  }
  const majority = classify(banks[0], counts[0]);
  if (!majority) return;
  const agree = banks.slice(1).filter((b, i) => {
    const witness = classify(b, counts[i + 1]);
    return (
      witness &&
      inColour(witness.ring, majority.ring) &&
      inColour(witness.core, majority.core)
    );
  });
  if (agree.length < 2) return;
  const attached = ink.map((v, i) =>
    Number(!!v || (d[i] <= 28 && inColour(colours[i], majority.ring))),
  );
  const edge = grid.distance(attached);
  return Uint8Array.from(edge, (v) => Number(v <= 4.5));
}
