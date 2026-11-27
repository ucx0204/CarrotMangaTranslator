import type { PixelRect } from "./maskGeometry";

export function smoothPrintTone(
  gray: Float32Array,
  box: PixelRect,
  profile: "glow" | "fine-pen" = "glow",
  penSigma = 0.85,
) {
  // Average the native dot screen before measuring the much wider glow.
  const horizontal = gray.slice();
  const result = gray.slice();
  const radius = profile === "fine-pen" ? 3 : 2;
  const kernel = profile === "fine-pen" ? penKernel(penSigma) : smoothAt;
  for (let y = 0; y < box.h; y++)
    for (let x = radius; x < box.w - radius; x++) {
      const i = y * box.w + x;
      horizontal[i] = kernel(gray, i, 1);
    }
  for (let y = radius; y < box.h - radius; y++)
    for (let x = 0; x < box.w; x++) {
      const i = y * box.w + x;
      result[i] = kernel(horizontal, i, box.w);
    }
  return result;
}

// The wider glow filter erases the contrast between a fine pen and its
// adjacent halftone. Resolve those two banks at the native scan scale.
function penKernel(sigma: number) {
  const weights = [0, 1, 2, 3].map((offset) =>
    Math.exp(-(offset ** 2) / (2 * sigma ** 2)),
  );
  const mass = weights[0] + 2 * (weights[1] + weights[2] + weights[3]);
  return (samples: Float32Array, i: number, step: number) => {
    let sum = samples[i];
    for (let k = 1; k <= 3; k++)
      sum += weights[k] * (samples[i - k * step] + samples[i + k * step]);
    return sum / mass;
  };
}

function smoothAt(samples: Float32Array, i: number, step: number) {
  return (
    (samples[i - 2 * step] +
      3 * samples[i - step] +
      4 * samples[i] +
      3 * samples[i + step] +
      samples[i + 2 * step]) /
    12
  );
}

/** Sample rays from real print edges into the surrounding exposed stock. */
export function measureWhiteShoulders(
  gray: Uint8Array,
  tone: Float32Array,
  mask: Uint8Array,
  bounds: PixelRect,
  inner: Float32Array,
  outer: Float32Array,
) {
  const { w, h } = bounds;
  const added = new Uint8Array(mask.length);
  for (let angle = 0; angle < 16; angle++) {
    const dx = Math.cos((angle * Math.PI) / 8),
      dy = Math.sin((angle * Math.PI) / 8);
    const offsets = Array.from({ length: 30 }, (_, j) => {
      const step = j - 6;
      return Math.round(step * dx) + w * Math.round(step * dy);
    });
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || inner[i] >= 1.6 || outer[i + offsets[15]] < 3.5) continue;
      const x = i % w,
        y = Math.floor(i / w);
      if (!rayInBounds(x, y, dx, dy, w, h)) continue;
      traceWhiteShoulder(i, offsets, tone, gray, outer, added);
    }
  }
  return added;
}

function rayInBounds(
  x: number,
  y: number,
  dx: number,
  dy: number,
  w: number,
  h: number,
) {
  return [-6, 23].every((k) => {
    const cx = x + Math.round(k * dx),
      cy = y + Math.round(k * dy);
    return cx >= 0 && cy >= 0 && cx < w && cy < h;
  });
}

function traceWhiteShoulder(
  i: number,
  offsets: number[],
  tone: Float32Array,
  gray: Uint8Array,
  outer: Float32Array,
  added: Uint8Array,
) {
  const values = offsets.map((delta) => tone[i + delta]);
  const terminal = values.slice(20, 29);
  const bank = terminal.reduce((a, b) => a + b, 0) / terminal.length;
  const start = Math.max(...values.slice(0, 7)),
    fall = start - bank;
  if (
    start <= 236 ||
    fall <= 13 ||
    Math.max(...terminal) - Math.min(...terminal) >= Math.max(6, 0.28 * fall)
  )
    return;
  // Averaging a hard ink edge also creates a slope. Require intermediate
  // shades on the original scan before extending into neighbouring artwork.
  const transition = offsets.slice(2, 21).map((delta) => gray[i + delta]);
  if (!hasMeasuredFalloff(values, transition, bank, fall)) return;
  for (let j = 7; j < 26; j++) {
    const level = values[j],
      at = i + offsets[j];
    if (level <= bank - Math.max(5, 0.13 * fall)) break;
    if (
      outer[at] < 14 &&
      level >= bank + Math.max(1.7, 0.045 * fall) &&
      gray[at] >= bank + Math.max(3, 0.06 * fall) &&
      Math.abs(gray[at] - level) < Math.max(18, 0.31 * fall)
    )
      added[at] = 1;
  }
}

function hasMeasuredFalloff(
  values: number[],
  transition: number[],
  bank: number,
  fall: number,
) {
  if (
    !transition.some((v) => v > bank + 0.15 * fall && v < bank + 0.5 * fall) ||
    !transition.some((v) => v >= bank + 0.5 * fall && v < bank + 0.86 * fall)
  )
    return false;
  const slope = values.slice(3, 19).map((v, j) => v - values[j + 4]);
  if (
    slope.filter((v) => v > 1.3).length < 3 ||
    Math.max(...slope) >= 0.63 * fall ||
    slope.reduce((v, d) => v + Math.max(0, -d), 0) >= Math.max(6, 0.25 * fall)
  )
    return false;
  return true;
}

/** A white press backing can end against shaded artwork at the page edge,
 * where an outward ray has no terminal samples. Measure the native gray on
 * either side, then follow continuous light from the original white plate. */
export function measureShadedPrintTone(
  gray: Uint8Array,
  tone: Float32Array,
  mask: Uint8Array,
  bounds: PixelRect,
  inner: Float32Array,
  outer: Float32Array,
) {
  const { w, h } = bounds;
  const range = localToneRange(tone, bounds);
  const stock = gray.map((v, i) =>
    Number(
      outer[i] > 6 &&
        outer[i] < 67 &&
        tone[i] >= 90 &&
        tone[i] <= 206 &&
        Math.abs(v - tone[i]) < 7 &&
        range[i] < 6.5,
    ),
  );
  const field = new Float32Array(gray.length),
    mass = field.slice(),
    spread = field.slice();
  for (let y = 1; y < h; y += 3) {
    for (let x = 1; x < w; x += 3) {
      const i = y * w + x;
      if (inner[i] >= 17 || outer[i] >= 15) continue;
      const sample = sampleGrayStock(tone, stock, bounds, x, y);
      if (!sample) continue;
      for (let yy = y - 1; yy < Math.min(h, y + 2); yy++) {
        const start = yy * w + x - 1;
        const end = yy * w + Math.min(w, x + 2);
        field.fill(sample.center, start, end);
        spread.fill(sample.spread, start, end);
        mass.fill(1, start, end);
      }
    }
  }
  const weight = smoothPrintTone(mass, bounds);
  const background = smoothPrintTone(field, bounds).map(
    (v, i) => v / Math.max(0.001, weight[i]),
  );
  const eligible = mask.map((_, i) =>
    Number(
      weight[i] > 0.13 &&
        outer[i] < 15.1 &&
        tone[i] >
          background[i] +
            Math.max(0.165 * (255 - background[i]), 1.4 * spread[i]) &&
        gray[i] > background[i] + Math.max(1.2, spread[i]),
    ),
  );
  const taper = eligible.map((on, i) => {
    const fraction = (tone[i] - background[i]) / (255 - background[i]);
    return Number(on && fraction > 0.13 && fraction < 0.83 && range[i] > 6);
  });
  return { eligible, taper };
}

function localToneRange(tone: Float32Array, { w, h }: PixelRect) {
  return tone.map((value, i) => {
    const x = i % w,
      y = Math.floor(i / w);
    let high = value,
      low = value;
    for (let yy = Math.max(0, y - 2); yy < Math.min(h, y + 3); yy++) {
      for (let xx = Math.max(0, x - 2); xx < Math.min(w, x + 3); xx++) {
        high = Math.max(high, tone[yy * w + xx]);
        low = Math.min(low, tone[yy * w + xx]);
      }
    }
    return high - low;
  });
}

function sampleGrayStock(
  tone: Float32Array,
  bank: Uint8Array,
  { w, h }: PixelRect,
  x: number,
  y: number,
) {
  const halves: number[][] = [[], []];
  let nearest = Infinity;
  for (let yy = Math.max(0, y - 20); yy < Math.min(h, y + 21); yy += 2) {
    for (let xx = Math.max(0, x - 20); xx < Math.min(w, x + 21); xx += 2) {
      const i = yy * w + xx,
        d = (xx - x) ** 2 + (yy - y) ** 2;
      if (!bank[i] || d > 400) continue;
      nearest = Math.min(nearest, d);
      halves[(Math.floor(xx / 5) + Math.floor(yy / 5)) % 2].push(tone[i]);
    }
  }
  if (nearest > 196 || halves.some((half) => half.length < 7)) return;
  const all = halves.flat();
  if (all.length < 19) return;
  const center = sortedQuantile(all, 0.5);
  if (
    center > 201 ||
    Math.abs(sortedQuantile(halves[0], 0.5) - sortedQuantile(halves[1], 0.5)) >
      2.1
  )
    return;
  const spread = sortedQuantile(
    all.map((v) => Math.abs(v - center)),
    0.75,
  );
  if (spread <= 3.5) return { center, spread: Math.max(1, spread) };
}

function sortedQuantile(values: number[], fraction: number) {
  values.sort((a, b) => a - b);
  const i = (values.length - 1) * fraction,
    base = Math.floor(i);
  return values[base] + (i - base) * (values[Math.ceil(i)] - values[base]);
}

/** A second drawn outline can interrupt a long sampling ray. A short strip
 * of stable exposed gray still fixes the end of the press between the lines. */
export function shortPublisherShoulders(
  gray: Uint8Array,
  tone: Float32Array,
  mask: Uint8Array,
  { w, h }: PixelRect,
  outer: Float32Array,
  printed: Float32Array,
  detected: Float32Array,
) {
  const candidates: number[] = [],
    supported = new Uint8Array(gray.length);
  outer.forEach((d, i) => {
    const x = i % w,
      y = Math.floor(i / w);
    if (
      d > 0 &&
      d < 9 &&
      printed[i] < 17 &&
      detected[i] < 18 &&
      gray[i] > 128 &&
      tone[i] < 250 &&
      Math.min(x, y, w - 1 - x, h - 1 - y) > 11
    )
      candidates.push(i);
  });
  for (let angle = 0; angle < 16; angle++) {
    const theta = (angle * Math.PI) / 8;
    const offsets = Array.from(
      { length: 21 },
      (_, j) =>
        Math.round((j - 9) * Math.cos(theta)) +
        w * Math.round((j - 9) * Math.sin(theta)),
    );
    for (const i of candidates) {
      if (supported[i]) continue;
      const at = offsets.map((d) => i + d);
      if (
        at.slice(0, 6).filter((k) => mask[k] && tone[k] > 241 && gray[k] > 242)
          .length < 2
      )
        continue;
      if ([12, 14, 16].some((start) => shortGrayBank(gray, tone, at, start)))
        supported[i] = 1;
    }
  }
  return supported.map((v, i) =>
    Number(
      v &&
        [-w - 1, -w, 1 - w, -1, 0, 1, w - 1, w, w + 1].reduce(
          (sum, delta) => sum + supported[i + delta],
          0,
        ) >= 5,
    ),
  );
}

function shortGrayBank(
  gray: Uint8Array,
  tone: Float32Array,
  at: number[],
  start: number,
) {
  const strip = at.slice(start, start + 5);
  const levels = strip.map((k) => tone[k]);
  const raw = strip.map((k) => gray[k]);
  const bank = sortedQuantile(levels, 0.5);
  const fall = Math.max(...at.slice(0, 6).map((k) => tone[k])) - bank;
  const center = at[9];
  if (
    bank <= 122 ||
    bank >= 209 ||
    fall <= 32 ||
    levels[4] - levels[0] >= 4.6 ||
    Math.max(...raw) - Math.min(...raw) >= 13 ||
    tone[center] - bank <= Math.max(6, 0.16 * fall) ||
    gray[center] <= bank + 4 ||
    Math.abs(gray[center] - tone[center]) >= 12
  )
    return false;
  return descendsToBank(gray, tone, at, start, bank, fall);
}

function descendsToBank(
  gray: Uint8Array,
  tone: Float32Array,
  at: number[],
  start: number,
  bank: number,
  fall: number,
) {
  let reversed = 0,
    midtones = 0;
  for (let j = 3; j <= start; j++) {
    if (
      j < start &&
      gray[at[j]] > bank + 0.2 * fall &&
      gray[at[j]] < bank + 0.8 * fall
    )
      midtones++;
    if (j < 4) continue;
    const rise = tone[at[j + 1]] - tone[at[j]];
    if (rise <= -0.5 * fall) return false;
    reversed += Math.max(0, rise);
  }
  return reversed < 4.7 && midtones >= 2;
}
