import { expandRect, type PixelRect } from "./maskGeometry";
import { maskComponents } from "./rasterMasks";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import type { MangaPage } from "../../shared/libraryTypes";
import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { protectUnselectedFluxPlan } from "./patternBlockEligibility";

type PaperSelection = Parameters<typeof protectUnselectedFluxPlan>[1] & {
  bitmap: Buffer;
  width: number;
  height: number;
  mode?: string;
  typographySegmentation?: KoharuTypographySegmentation;
  sourceEraseConstraintsByBlock?: Readonly<
    Record<string, InpaintingWindowMask>
  >;
};

export type MeasuredPaperPatch = {
  bounds: PixelRect;
  data: Uint8Array;
  pixels: Uint8Array;
};
type PaperField = {
  bounds: PixelRect;
  word: PixelRect;
  original: Buffer;
  stride: number;
};

/** Sample both banks of each scan line. A cross-check on multiple samples in
 * each bank rejects texture. Interpolation preserves pale coloured gradients. */
function paperBanks(field: PaperField, vertical: boolean) {
  const { bounds, original } = field;
  const axis = paperAxis(field, vertical);
  const { length, rows, lo, hi, start, step, rowStep } = axis;
  if (lo < 8 || length - hi < 8) return;
  const banks = new Uint8Array(rows * 6);
  const known: number[] = [];
  for (let row = 0; row < rows; row++) {
    const at = start + row * rowStep;
    const left = sampleBank(original, at, step, 0, lo - 3);
    const right = sampleBank(original, at, step, hi + 3, length);
    if (!left || !right || left.some((v, c) => Math.abs(v - right[c]) > 36))
      continue;
    banks.set(left, row * 6);
    banks.set(right, row * 6 + 3);
    known.push(row);
  }
  if (known.length < rows * 0.65) return;
  return {
    pixels: interpolatePaperRows(bounds, axis, banks, known),
    stability: known.length / rows,
  };
}

function paperAxis(field: PaperField, vertical: boolean) {
  const { bounds, word, stride } = field;
  return {
    length: vertical ? bounds.h : bounds.w,
    rows: vertical ? bounds.w : bounds.h,
    lo: vertical ? word.y : word.x,
    hi: vertical ? word.y + word.h : word.x + word.w,
    start: (bounds.y * stride + bounds.x) * 4,
    step: vertical ? stride * 4 : 4,
    rowStep: vertical ? 4 : stride * 4,
    along: vertical ? bounds.w : 1,
    across: vertical ? 1 : bounds.w,
  };
}

function interpolatePaperRows(
  bounds: PixelRect,
  axis: ReturnType<typeof paperAxis>,
  banks: Uint8Array,
  known: number[],
) {
  const { rows, length, lo, hi, along, across } = axis;
  const pixels = new Uint8Array(bounds.w * bounds.h * 3);
  let next = 0;
  for (let row = 0; row < rows; row++) {
    while (next + 1 < known.length && known[next] < row) next++;
    const a = known[Math.max(0, next - 1)],
      b = known[next];
    const blend = Math.max(0, Math.min(1, (row - a) / Math.max(1, b - a)));
    const left = [],
      right = [];
    for (let c = 0; c < 3; c++) {
      left.push(banks[a * 6 + c] * (1 - blend) + banks[b * 6 + c] * blend);
      right.push(
        banks[a * 6 + 3 + c] * (1 - blend) + banks[b * 6 + 3 + c] * blend,
      );
    }
    for (let x = 0; x < length; x++) {
      const at = 3 * (x * along + row * across);
      const f = Math.max(
        0,
        Math.min(1, (2 * x - lo + 4) / (length + hi - lo + 6)),
      );
      for (let c = 0; c < 3; c++)
        pixels[at + c] = Math.round(left[c] + f * (right[c] - left[c]));
    }
  }
  return pixels;
}

function sampleBank(
  image: Buffer,
  start: number,
  step: number,
  lo: number,
  hi: number,
) {
  const channels: number[][] = [[], [], []];
  for (let i = lo; i < hi; i++) {
    const at = start + i * step;
    if (image[at + 3] !== 255) return;
    for (let c = 0; c < 3; c++) channels[c].push(image[at + c]);
  }
  const median = channels.map((values) => {
    values.sort((a, b) => a - b);
    return values[values.length >> 1];
  });
  let noisy = 0;
  for (let i = lo; i < hi; i++)
    if (median.some((v, c) => Math.abs(v - image[start + i * step + c]) > 7))
      noisy++;
  if (noisy <= 0.21 * (hi - lo)) return median;
}

function measureFit(
  field: PaperField,
  banks: NonNullable<ReturnType<typeof paperBanks>>,
) {
  const { bounds, word, stride, original } = field;
  const residual = new Uint8Array(bounds.w * bounds.h);
  let matched = 0,
    contrast = 0,
    coloured = 0,
    light = 0,
    darkPaper = 0,
    paleInk = 0;
  for (let y = 0; y < bounds.h; y++)
    for (let x = 0; x < bounds.w; x++) {
      const i = y * bounds.w + x,
        at = ((y + bounds.y) * stride + bounds.x + x) * 4;
      const p = 3 * i,
        B = banks.pixels[p],
        G = banks.pixels[p + 1],
        R = banks.pixels[p + 2];
      residual[i] = Math.max(
        Math.abs(B - original[at]),
        Math.abs(G - original[at + 1]),
        Math.abs(R - original[at + 2]),
      );
      if (!inside(word, x, y)) continue;
      matched += Number(residual[i] <= 9);
      contrast += Number(residual[i] > 53);
      coloured += Number(Math.max(B, G, R) - Math.min(B, G, R) > 105);
      light += Number(Math.max(B, G, R) >= 190);
      darkPaper += Number(Math.max(B, G, R) < 108);
      paleInk += Number(
        Math.min(original[at], original[at + 1], original[at + 2]) > 209,
      );
    }
  const area = word.w * word.h;
  const saturated = coloured > 0.98 * area;
  if (
    (!saturated &&
      light < 0.9 * area &&
      !(darkPaper > 0.96 * area && paleInk > 0.035 * area)) ||
    contrast < 0.014 * area ||
    matched < (saturated ? 0.025 : 0.3) * area
  )
    return;
  return {
    pixels: banks.pixels,
    residual,
    score: matched / area + 0.1 * banks.stability,
    saturated,
  };
}

function inside(rect: PixelRect, x: number, y: number) {
  return (
    x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h
  );
}

function measureInk(
  field: PaperField,
  fit: NonNullable<ReturnType<typeof measureFit>>,
) {
  const { bounds, word } = field;
  const { w, h } = bounds;
  const ink = new Uint8Array(w * h);
  let captured = 0,
    rejected = 0;
  for (const part of maskComponents(
    fit.residual.map((v) => Number(v > 14)),
    w,
    h,
    1,
  )) {
    const r = part.rect;
    let inWord = 0,
      dark = 0,
      selectedDark = 0;
    part.data.forEach((on, i) => {
      if (!on) return;
      const x = r.x + (i % r.w),
        y = r.y + Math.floor(i / r.w);
      const bold = Number(fit.residual[y * w + x] > 50);
      dark += bold;
      if (inside(word, x, y)) {
        inWord++;
        selectedDark += bold;
      }
    });
    if (!inWord || dark < 2) continue;
    if (
      Math.min(r.x, r.y, w - r.x - r.w, h - r.y - r.h) <= 1 ||
      inWord < 0.72 * part.area
    ) {
      rejected += selectedDark;
      continue;
    }
    captured += dark;
    part.data.forEach((on, i) => {
      if (on) ink[(r.y + Math.floor(i / r.w)) * w + r.x + (i % r.w)] = 1;
    });
  }
  if (captured < 12 || rejected > Math.max(8, 0.045 * captured)) return;
  return {
    bounds,
    pixels: fit.pixels,
    data: dilateBinaryMaskDisk(ink, w, h, 3),
  };
}

/** The OCR rectangle is a reading hint. Only disconnected printed components
 * within it are replaced. Original outlines extending out of the word veto
 * the repair, including rules which pass between otherwise valid letters. */
export function measureQwenPaperGradient(
  original: Buffer,
  stride: number,
  bounds: PixelRect,
  selection: PixelRect,
) {
  if (bounds.w * bounds.h > 260_000 || Math.min(selection.w, selection.h) < 8)
    return;
  const word = {
    ...selection,
    x: selection.x - bounds.x,
    y: selection.y - bounds.y,
  };
  const field = { original, stride, bounds, word };
  const fits = [false, true].flatMap((vertical) => {
    const banks = paperBanks(field, vertical);
    const fit = banks && measureFit(field, banks);
    return fit ? [fit] : [];
  });
  const best = fits.sort((a, b) => b.score - a.score)[0];
  if (best) return measureInk(field, best);
}

export function pasteQwenPaperGradient(
  patch: MeasuredPaperPatch,
  bitmap: Buffer,
  stride: number,
) {
  const { bounds, data, pixels } = patch;
  data.forEach((on, i) => {
    if (!on) return;
    const at =
      ((bounds.y + Math.floor(i / bounds.w)) * stride +
        bounds.x +
        (i % bounds.w)) *
      4;
    for (let c = 0; c < 3; c++) bitmap[at + c] = pixels[i * 3 + c];
  });
}

export function selectedPaperGradient(
  options: PaperSelection,
  block: MangaPage["blocks"][number],
  selection: PixelRect,
  bounds: PixelRect,
) {
  if (!canMeasurePaper(options, block)) return;
  const probe = (frame: PixelRect) =>
    measureQwenPaperGradient(options.bitmap, options.width, frame, selection);
  const patch =
    probe(bounds) ??
    probe(expandRect(selection, options.width, options.height, 8)) ??
    probe(expandRect(selection, options.width, options.height, 10));
  if (!patch) return;
  const plan = {
    modelMask: patch,
    compositeMask: { ...patch, data: patch.data.slice() },
    constraint: patch,
    featherPx: 0,
  };
  protectUnselectedFluxPlan(plan, options, options.bitmap);
  const boundary = options.sourceEraseConstraintsByBlock?.[block.id];
  if (!clipPaperOwnership(patch, plan.compositeMask.data, boundary, options))
    return;
  // Do not finish a word when peer protection would leave a selected stroke intact.
  if (
    patch.data.some(
      (on, i) =>
        on &&
        !plan.compositeMask.data[i] &&
        isBoldChange(patch, options.bitmap, options.width, i),
    )
  )
    return;
  return { ...patch, data: plan.compositeMask.data };
}

function canMeasurePaper(
  options: PaperSelection,
  block: Parameters<typeof selectedPaperGradient>[1],
) {
  return (
    options.conditionOnTypography &&
    options.typographySegmentation &&
    options.mode === "flux-region" &&
    block.textRole === "ordinary" &&
    block.bubbleLayout?.origin !== "manual" &&
    Boolean(block.sourceText?.trim())
  );
}

function isBoldChange(
  patch: MeasuredPaperPatch,
  bitmap: Buffer,
  width: number,
  i: number,
) {
  const { bounds, pixels } = patch;
  const at =
    ((bounds.y + Math.floor(i / bounds.w)) * width +
      bounds.x +
      (i % bounds.w)) *
    4;
  return (
    Math.max(
      ...[0, 1, 2].map((c) => Math.abs(pixels[i * 3 + c] - bitmap[at + c])),
    ) > 36
  );
}

function clipPaperOwnership(
  patch: MeasuredPaperPatch,
  data: Uint8Array,
  boundary: InpaintingWindowMask | undefined,
  options: PaperSelection,
) {
  if (!boundary) return true;
  const allowed = boundary.bounds;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const x = patch.bounds.x + (i % patch.bounds.w),
      y = patch.bounds.y + Math.floor(i / patch.bounds.w);
    if (
      inside(allowed, x, y) &&
      boundary.data[(y - allowed.y) * allowed.w + x - allowed.x]
    )
      continue;
    if (isBoldChange(patch, options.bitmap, options.width, i)) return false;
    data[i] = 0;
  }
  return true;
}
