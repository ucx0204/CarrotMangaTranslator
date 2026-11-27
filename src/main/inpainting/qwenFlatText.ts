import {
  isPaperChecker,
  hasNeutralSoundBorder,
  hasCleanSoundPaper,
} from "./qwenScreenedGuide";
import { maskBoundsInRect } from "./imageRaster";
import { expandRect, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import { maskComponents } from "./rasterMasks";

import {
  localWhitePaperBanks,
  measuredBurstPaperBank,
  samplePaperColor,
} from "./qwenPaperBank";

type Ink = ReturnType<typeof maskComponents>[number];

/** A recognised short effect can consist of just one glyph. Its intact
 * paper border and the exposed paper between strokes must agree with the
 * reconstructed stock before a diffusion pass can be skipped. */
export function restoreIsolatedSoundPaper(
  source: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
  hint: unknown,
) {
  if (
    typeof hint !== "string" ||
    !/^sound:[\p{Script=Katakana}\p{Script=Hiragana}][\p{Script=Katakana}\p{Script=Hiragana}ー…!?・.]{0,11}$/u.test(
      hint,
    )
  )
    return;
  const rect = maskBoundsInRect(mask, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  if (!rect || Math.max(rect.w, rect.h) > 160) return;
  const box = expandRect(rect, width, height, 12);
  if (box.w !== rect.w + 24 || box.h !== rect.h + 24) return;
  if (!hasNeutralSoundBorder(source, width, box, rect)) return;
  const repair = restoreFlatQwenText(source, mask, width, height, true);
  if (!repair) return;
  clearQwenPaperRinging(source, repair, mask, width, height);
  return hasCleanSoundPaper(repair, width, box) ? repair : undefined;
}

/** DCT ringing can sit several pixels outside the black glyphs. Only level
 * isolated pale remnants next to removed ink, on measured uniform white paper. */
export function clearQwenPaperRinging(
  source: Buffer,
  restored: Buffer,
  stencil: Uint8Array,
  width: number,
  height: number,
) {
  const bounds = maskBoundsInRect(stencil, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  if (!bounds) return;
  const box = expandRect(bounds, width, height, 19);
  const offset = (i: number) =>
    ((box.y + Math.floor(i / box.w)) * width + box.x + (i % box.w)) * 4;
  const ink = Uint8Array.from({ length: box.w * box.h }, (_, i) => {
    const p = offset(i);
    return Number(source[p + 1] < 208 && restored[p + 1] >= 245);
  });
  if (!ink.some(Boolean)) return;
  const distance = distanceToMask(ink, box.w, box.h);
  const paper = nativeWhiteForRinging(restored, distance, offset, 0.07);
  if (paper) clearDetachedRinging(restored, distance, offset, box, paper);
  const localPaper =
    paper ?? nativeWhiteForRinging(restored, distance, offset, 0.22);
  const candidate =
    localPaper ?? nativeWhiteForRinging(restored, distance, offset, 0.45);
  if (candidate)
    clearFaintRinging(
      {
        restored,
        distance,
        offset,
        box,
        paper: candidate,
        bank: localPaper
          ? () => true
          : localWhitePaperBanks(source, distance, offset, box.w, box.h),
      },
      ink,
    );
}

type PaperRingingSample = {
  bank: (i: number) => boolean;
  restored: Buffer;
  distance: Float32Array;
  offset: (i: number) => number;
  box: PixelRect;
  paper: number[];
};

function clearDetachedRinging(
  restored: Buffer,
  distance: Float32Array,
  offset: (i: number) => number,
  box: PixelRect,
  paper: number[],
) {
  const remaining = Uint8Array.from(distance, (_, i) => {
    const p = offset(i);
    return Number(paper.some((v, c) => restored[p + c] < v - 1));
  });
  for (const part of maskComponents(remaining, box.w, box.h, 1)) {
    const cells: number[] = [];
    let near = Infinity,
      far = 0,
      contrast = 0;
    part.data.forEach((set, i) => {
      if (!set) return;
      const j =
        (part.rect.y + Math.floor(i / part.rect.w)) * box.w +
        part.rect.x +
        (i % part.rect.w);
      const p = offset(j);
      cells.push(p);
      near = Math.min(near, distance[j]);
      far = Math.max(far, distance[j]);
      contrast = Math.max(
        contrast,
        ...paper.map((v, c) => v - restored[p + c]),
      );
    });
    // A line continuing into the illustration or appreciably darker than
    // the paper's compression shoulder belongs to the original drawing.
    if (near > 8.5 || far > 11.5 || contrast > 34) continue;
    for (const p of cells) restored.set(paper, p);
  }
}

function nativeWhiteForRinging(
  restored: Buffer,
  distance: Float32Array,
  offset: (i: number) => number,
  lowerQuantile: number,
) {
  const ring: number[] = [];
  for (let i = 0; i < distance.length; i++) {
    const p = offset(i);
    if (distance[i] > 10 && distance[i] < 18 && restored[p + 1] > 223)
      ring.push(p);
  }
  if (ring.length < 32) return;
  const paper = [0, 1, 2].map((c) => {
    const values = Uint8Array.from(ring, (p) => restored[p + c]).sort();
    const median = values[values.length >> 1];
    return median >= 249 &&
      values[Math.floor(lowerQuantile * values.length)] >= median - 3
      ? median
      : -1;
  });
  return paper.includes(-1) ? undefined : paper;
}

/** Weak JPEG transitions can connect the outline of a removed stroke to distant
 * drawing through just two levels of luminance. Check the darker fragments
 * independently, then clear their faint shoulders on corroborated native paper. */
function clearFaintRinging(sample: PaperRingingSample, ink: Uint8Array) {
  const { restored, distance, offset, box, paper } = sample;
  const contrast = Uint8Array.from(ink, (_, i) =>
    Math.max(
      0,
      ...paper.map((level, channel) => level - restored[offset(i) + channel]),
    ),
  );
  let clean = 0,
    total = 0;
  ink.forEach((set, i) => {
    if (set) {
      total++;
      clean += Number(contrast[i] <= 3);
    }
  });
  if (total < 5 || clean < 0.82 * total) return;
  const pieces = maskComponents(
    contrast.map((value) => Number(value >= 5)),
    box.w,
    box.h,
    1,
  );
  const accepted = new Uint8Array(ink.length);
  for (const piece of pieces) {
    const cells = ringingFragment(piece, sample, contrast);
    for (const i of cells) accepted[i] = 1;
  }
  const dark = contrast.map((value, i) => Number(value > 32 && !accepted[i]));
  const toDrawing = distanceToMask(dark, box.w, box.h);
  const toFragment = distanceToMask(accepted, box.w, box.h);
  for (let i = 0; i < contrast.length; i++) {
    if (toDrawing[i] <= 1.4 || contrast[i] === 0 || !sample.bank(i)) continue;
    const shoulder = isRingingShoulder(
      contrast[i],
      toDrawing[i],
      distance[i],
      toFragment[i],
    );
    if (accepted[i] || (shoulder && !hasFaintPenBeyond(i, contrast, sample)))
      restored.set(paper, offset(i));
  }
}

function isRingingShoulder(
  contrast: number,
  toDrawing: number,
  toInk: number,
  toFragment: number,
) {
  return (
    contrast < 5 &&
    toDrawing > 2.5 &&
    toInk <= 11.4 &&
    (toFragment <= 2.5 || toInk < 7.5)
  );
}

function ringingFragment(
  piece: Ink,
  sample: PaperRingingSample,
  contrast: Uint8Array,
) {
  const cells: number[] = [];
  let near = Infinity,
    far = 0,
    tail = 0,
    darkest = 0;
  piece.data.forEach((set, k) => {
    if (!set) return;
    const i =
      (piece.rect.y + Math.floor(k / piece.rect.w)) * sample.box.w +
      piece.rect.x +
      (k % piece.rect.w);
    const d = sample.distance[i];
    cells.push(i);
    near = Math.min(near, d);
    far = Math.max(far, d);
    tail += Number(d > 11.4);
    darkest = Math.max(darkest, contrast[i]);
  });
  const checker =
    darkest <= 42 &&
    near <= 5.3 &&
    far <= 8.7 &&
    isPaperChecker(piece, cells, sample.box.w, contrast);
  return (darkest <= 32 || checker) &&
    near <= 7.5 &&
    far <= 16.2 &&
    tail <= 0.07 * cells.length
    ? cells
    : [];
}

function hasFaintPenBeyond(
  i: number,
  contrast: Uint8Array,
  sample: PaperRingingSample,
) {
  const { box, distance } = sample;
  const x = i % box.w,
    y = Math.floor(i / box.w);
  for (let turn = 0; turn < 16; turn++) {
    const angle = (Math.PI * turn) / 8,
      dx = Math.cos(angle),
      dy = Math.sin(angle);
    let count = 0,
      end = i;
    for (let step = 1; step <= 14; step++) {
      const u = Math.round(x + step * dx),
        v = Math.round(y + step * dy);
      if (u < 0 || v < 0 || u >= box.w || v >= box.h) break;
      end = v * box.w + u;
      count += Number(contrast[end] > 0);
    }
    if (count >= 12 && distance[end] > 12) return true;
  }
  return false;
}

/** Estimate paper inside a detected speech region using pixels separated from
 * every selected ink stroke. A stroke continuing into the illustration vetoes
 * this shortcut, including when its crossing is smaller than a whole glyph. */
export function restoreFlatQwenText(
  source: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
  allowCompressionFringe = false,
): Buffer | undefined {
  const rect = maskBoundsInRect(mask, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  if (!rect) return;
  if (allowCompressionFringe && Math.max(rect.w, rect.h) < 50) return;
  const crop = expandRect(rect, width, height, 12);
  const pageIndex = (i: number) =>
    (crop.y + Math.floor(i / crop.w)) * width + crop.x + (i % crop.w);
  const local = Uint8Array.from({ length: crop.w * crop.h }, (_, i) =>
    Number(Boolean(mask[pageIndex(i)])),
  );
  const lum = Uint8Array.from(local, (_, i) => {
    const p = pageIndex(i) * 4;
    return Math.round(
      (29 * source[p] + 150 * source[p + 1] + 77 * source[p + 2]) / 256,
    );
  });
  // The high-resolution detector can track the black strokes so tightly
  // that nearly all of the selected pixels are ink. Sample the surrounding
  // paper separately while retaining the original mask for ink ownership.
  const paperNeighborhood = dilateBinaryMaskDisk(local, crop.w, crop.h, 10);
  const selected = lum.filter((_, i) => Boolean(paperNeighborhood[i])).sort();
  const level = selected[Math.floor(0.91 * selected.length)];
  if (level < 249) return;
  const threshold = level - (allowCompressionFringe ? 10 : 5);
  const ink = Uint8Array.from(lum, (value) => Number(value < threshold));
  const allowed = new Uint8Array(local.length);
  const context = {
    w: crop.w,
    h: crop.h,
    rect,
    local,
    allowed,
    lum,
    paperNeighborhood,
    surrounding: dilateBinaryMaskDisk(local, crop.w, crop.h, 5),
  };
  for (const component of maskComponents(ink, crop.w, crop.h, 1)) {
    if (!collectPrintedStroke(component, context)) return;
  }
  if (!allowed.some(Boolean)) return;
  const fill = dilateBinaryMaskDisk(allowed, crop.w, crop.h, 2);
  const separated = dilateBinaryMaskDisk(fill, crop.w, crop.h, 3);
  const bank = allowCompressionFringe
    ? measuredBurstPaperBank(
        ink,
        allowed,
        fill,
        separated,
        paperNeighborhood,
        lum,
        crop.w,
        crop.h,
      )
    : paperNeighborhood;
  const paper = samplePaperColor(source, bank, lum, separated, pageIndex);
  if (!paper) return;
  const out = Buffer.from(source);
  fill.forEach((on, i) => {
    if (on) out.set(paper, pageIndex(i) * 4);
  });
  return out;
}

function collectPrintedStroke(
  part: Ink,
  {
    w,
    h,
    rect,
    local,
    allowed,
    surrounding,
    lum,
    paperNeighborhood,
  }: {
    w: number;
    h: number;
    rect: PixelRect;
    local: Uint8Array;
    allowed: Uint8Array;
    surrounding: Uint8Array;
    lum: Uint8Array;
    paperNeighborhood: Uint8Array;
  },
): boolean {
  const cells: number[] = [];
  let owned = 0,
    near = 0;
  part.data.forEach((on, i) => {
    if (!on) return;
    const p =
      (part.rect.y + Math.floor(i / part.rect.w)) * w +
      part.rect.x +
      (i % part.rect.w);
    cells.push(p);
    owned += local[p];
    near += surrounding[p];
  });
  if (!owned) return true;
  const { x, y, w: dw, h: dh } = part.rect;
  if (x === 0 || y === 0 || x + dw === w || y + dh === h) return false;
  // JPEG ringing can join to a glyph beyond the close ownership margin.
  // A darker continuation or one escaping the measured neighbourhood still
  // belongs to the illustration.
  if (
    near < 0.98 * part.area &&
    cells.some(
      (p) => !surrounding[p] && (lum[p] < 235 || !paperNeighborhood[p]),
    )
  )
    return false;
  if (Math.min(dw, dh) >= 0.65 * Math.max(rect.w, rect.h)) return false;
  if (part.area >= 0.38 * rect.w * rect.h) return false;
  for (const p of cells) allowed[p] = 1;
  return true;
}
