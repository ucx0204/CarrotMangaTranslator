import type { PixelRect } from "./maskGeometry";
import { printMaskGrid } from "./qwenPrintedPigment";
import { distanceToMask } from "./pageMaskComposite";
import {
  createPoissonDomain,
  PoissonConvergenceError,
  solvePoissonChannel,
} from "./retouchPoisson";

/** Continue a pale gradient across a small verified effect. Every exposed
 * boundary sample must be neutral and light, including enclosed letter holes. */
export function restoreLightEffectGradient(
  source: Buffer,
  mask: Uint8Array,
  width: number,
  signal: AbortSignal,
) {
  const active = interiorMaskPixels(mask, width);
  if (!active || !hasNeutralPaperEdge(source, mask, active, width)) return;
  const domain = createPoissonDomain(Int32Array.from(active), width);
  const result = Buffer.from(source);
  for (let channel = 0; channel < 3; channel++) {
    signal.throwIfAborted();
    const boundary = (p: number) => source[p * 4 + channel] / 255;
    let levels: Float32Array;
    try {
      levels = solvePoissonChannel(domain, boundary, () =>
        signal.throwIfAborted(),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof PoissonConvergenceError) return;
      throw error;
    }
    active.forEach((p, i) => {
      result[4 * p + channel] = Math.max(
        0,
        Math.min(255, Math.round(levels[i] * 255)),
      );
    });
  }
  return result;
}

function interiorMaskPixels(mask: Uint8Array, width: number) {
  const active: number[] = [];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const x = p % width;
    if (x === 0 || x === width - 1 || p < width || p >= mask.length - width)
      return;
    active.push(p);
  }
  if (active.length && active.length <= 72 ** 2) return active;
}

function hasNeutralPaperEdge(
  source: Buffer,
  mask: Uint8Array,
  active: number[],
  width: number,
) {
  const offsets = [-1, 1, -width, width];
  for (const p of active) {
    for (const offset of offsets) {
      const neighbor = p + offset;
      if (mask[neighbor]) continue;
      const k = neighbor * 4;
      const minimum = Math.min(source[k], source[k + 1], source[k + 2]);
      const maximum = Math.max(source[k], source[k + 1], source[k + 2]);
      if (source[k + 3] !== 255 || minimum < 200 || maximum - minimum > 3)
        return false;
    }
  }
  return true;
}

/** The grain at the rim of a vignette can invalidate a whole-crop paper sample.
 * Check two independently exposed sides near the candidate mark instead. */
export function localWhitePaperBanks(
  source: Buffer,
  distance: Float32Array,
  offset: (i: number) => number,
  width: number,
  height: number,
) {
  const stride = Math.ceil(width / 6);
  const measured = new Int8Array(stride * Math.ceil(height / 6));
  return (i: number) => {
    const tx = Math.floor((i % width) / 6);
    const ty = Math.floor(i / width / 6);
    const cell = ty * stride + tx;
    if (measured[cell]) return measured[cell] > 0;
    const cx = 6 * tx + 3,
      cy = 6 * ty + 3;
    const counts = [0, 0, 0, 0],
      light = [0, 0, 0, 0],
      white = [0, 0, 0, 0];
    for (
      let y = Math.max(0, cy - 23);
      y <= Math.min(height - 1, cy + 23);
      y += 2
    ) {
      for (
        let x = Math.max(0, cx - 23);
        x <= Math.min(width - 1, cx + 23);
        x += 2
      ) {
        const at = y * width + x,
          dx = x - cx,
          dy = y - cy,
          radius = dx * dx + dy * dy;
        if (
          distance[at] < 4.1 ||
          distance[at] > 30 ||
          radius < 36 ||
          radius > 529
        )
          continue;
        const sector =
          Math.abs(dx) >= Math.abs(dy) ? Number(dx < 0) : 2 + Number(dy < 0);
        const pixel = offset(at);
        const level = Math.min(
          source[pixel],
          source[pixel + 1],
          source[pixel + 2],
        );
        counts[sector]++;
        light[sector] += Number(level >= 249);
        white[sector] += Number(level >= 253);
      }
    }
    measured[cell] =
      counts.filter(
        (n, side) => n >= 4 && light[side] > 0.78 * n && white[side] >= 0.5 * n,
      ).length >= 2
        ? 1
        : -1;
    return measured[cell] > 0;
  };
}

/** A thin JPEG bridge may join a letter to a burst ray at the pale threshold.
 * Confirm a second, independent stock sample between the darker cores. Keep
 * the source wherever the original ray is closer than the confirmed print. */
export function measuredBurstPaperBank(
  ink: Uint8Array,
  letters: Uint8Array,
  fill: Uint8Array,
  separated: Uint8Array,
  neighborhood: Uint8Array,
  tone: Uint8Array,
  w: number,
  h: number,
) {
  const other = ink.map((v, i) => Number(v && !letters[i]));
  const toOther = distanceToMask(other, w, h);
  const bank = neighborhood.map((v, i) => Number(v && toOther[i] > 3.3));
  let total = 0,
    independent = 0,
    light = 0;
  for (let i = 0; i < bank.length; i++) {
    if (!neighborhood[i] || separated[i]) continue;
    total++;
    independent += bank[i];
    light += Number(tone[i] > 244);
  }
  if (independent < 90 || independent < 0.65 * total || light < 0.9 * total)
    return;
  const toLetters = distanceToMask(letters, w, h);
  for (let i = 0; i < fill.length; i++)
    if (toOther[i] <= toLetters[i] + 0.7) fill[i] = 0;
  return bank;
}

export function samplePaperColor(
  source: Buffer,
  local: Uint8Array | undefined,
  lum: Uint8Array,
  separated: Uint8Array,
  pageIndex: (i: number) => number,
) {
  if (!local) return;
  const colors: number[][] = [[], [], []];
  let bright = 0;
  for (let i = 0; i < local.length; i++) {
    if (!local[i] || separated[i]) continue;
    bright += Number(lum[i] > 244);
    const p = pageIndex(i) * 4;
    for (let c = 0; c < 3; c++) colors[c].push(source[p + c]);
  }
  if (colors[0].length < 12 || bright < 0.975 * colors[0].length) return;
  const paper = colors.map(
    (channel) => channel.sort((a, b) => a - b)[Math.floor(channel.length / 2)],
  );
  return Math.min(...paper) >= 243 ? paper : undefined;
}

export function isIsolatedBalloonType(
  bitmap: Buffer,
  width: number,
  rect: PixelRect,
  detected: Uint8Array,
  owned: Uint8Array,
  reach: Float32Array,
) {
  const strokes = new Uint8Array(detected.length);
  let ink = 0,
    labeled = 0,
    missing = 0,
    bank = 0,
    paper = 0;
  for (let i = 0; i < detected.length; i++) {
    const pos =
      4 * ((rect.y + Math.floor(i / rect.w)) * width + rect.x + (i % rect.w));
    const min = Math.min(bitmap[pos], bitmap[pos + 1], bitmap[pos + 2]);
    const max = Math.max(bitmap[pos], bitmap[pos + 1], bitmap[pos + 2]);
    if (max - min > 7 || bitmap[pos + 3] !== 255) return false;
    if (min < 176) {
      strokes[i] = 1;
      ink++;
      labeled += Number(!!detected[i]);
      missing += Number(!!detected[i]) * Number(!owned[i]);
    }
    if (reach[i] > 3.5) {
      bank++;
      paper += Number(min >= 246);
    }
  }
  if (
    ink < 80 ||
    ink > 0.35 * detected.length ||
    labeled < 0.93 * ink ||
    missing === 0 ||
    !hasUniformSamplingBank(bank, paper, detected.length)
  )
    return false;
  return (
    missing >= 0.03 * ink ||
    tracesClippedGlyphs(rect, strokes, detected, owned, missing)
  );
}
function tracesClippedGlyphs(
  rect: PixelRect,
  strokes: Uint8Array,
  detected: Uint8Array,
  owned: Uint8Array,
  missing: number,
) {
  // In a long dialogue even a visibly cut stroke can occupy less than one
  // percent of the text. Trace its dark pixels back into the selected glyph.
  let confirmed = 0;
  for (const part of printMaskGrid(rect.w, rect.h).components(strokes, 12)) {
    const b = part.rect;
    if (
      !b.x ||
      !b.y ||
      b.x + b.w === rect.w ||
      b.y + b.h === rect.h ||
      Math.max(b.w, b.h) > 75
    )
      continue;
    let labeled = 0,
      retained = 0,
      clipped = 0;
    part.data.forEach((on, i) => {
      if (!on) return;
      const j = (b.y + Math.floor(i / b.w)) * rect.w + b.x + (i % b.w);
      labeled += Number(!!detected[j]);
      retained += Number(!!owned[j]);
      clipped += Number(!!detected[j] && !owned[j]);
    });
    if (labeled >= 0.85 * part.area && retained >= 0.65 * part.area)
      confirmed += clipped;
  }
  return confirmed === missing;
}

function hasUniformSamplingBank(bank: number, paper: number, length: number) {
  return bank >= 0.25 * length && paper >= 0.985 * bank;
}
function matchesDetectedType(
  coverage: (mask: Uint8Array) => number,
  detected: Uint8Array,
  owned: Uint8Array,
  holes: Uint8Array,
  filled: Uint8Array,
) {
  return (
    coverage(detected) >= 0.9 &&
    coverage(owned) >= 0.28 &&
    coverage(holes) >= 0.06 &&
    coverage(filled) >= 0.99
  );
}

export function onLightPaper(
  reach: Float32Array,
  detected: Uint8Array,
  tone: Uint8Array,
) {
  let bank = 0,
    paper = 0;
  for (let i = 0; i < reach.length; i++) {
    if (reach[i] < 2.4 || reach[i] > 5.4 || detected[i]) continue;
    bank++;
    paper += Number(tone[i] >= 230);
  }
  return bank >= 20 && paper >= 0.88 * bank;
}

export function enclosedTypeFaces(
  bounds: PixelRect,
  selected: PixelRect,
  dark: Uint8Array,
  detected: Uint8Array,
  owned: Uint8Array,
  holes: Uint8Array,
  filled: Uint8Array,
) {
  const ink = new Uint8Array(detected.length);
  for (const face of printMaskGrid(bounds.w, bounds.h).components(dark, 12)) {
    const { x, y, w, h } = face.rect;
    if (
      Math.max(w, h) > 75 ||
      bounds.x + x < selected.x ||
      bounds.y + y < selected.y ||
      bounds.x + x + w > selected.x + selected.w ||
      bounds.y + y + h > selected.y + selected.h
    )
      continue;
    const pixels: number[] = [];
    face.data.forEach((on, i) => {
      if (on) pixels.push((y + Math.floor(i / w)) * bounds.w + x + (i % w));
    });
    const coverage = (mask: Uint8Array) =>
      pixels.reduce((n, i) => n + Number(!!mask[i]), 0) / pixels.length;
    if (!matchesDetectedType(coverage, detected, owned, holes, filled))
      continue;
    for (const i of pixels) ink[i] = 1;
  }
  return ink;
}
