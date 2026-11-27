import { fillEnclosedMaskHoles } from "../bubbleLayout/bubbleMaskComponents";
import { maskBoundsInRect } from "./imageRaster";
import { expandRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { continueQwenPen } from "./qwenPenContinuation";
import { clearQwenPaperRinging } from "./qwenFlatText";
import { refineQwenCaptionStock } from "./qwenCaptionStock";
import { maskComponents } from "./rasterMasks";

type Dot = {
  x: number;
  y: number;
  area: number;
  cells: number[];
  owned: number;
};

type PaperSample = {
  source: Buffer;
  prediction: Buffer;
  distance: Float32Array;
  offset: (i: number) => number;
  width: number;
  height: number;
};

/** When source paper and Qwen agree on the substrate, remove the VAE's faint
 * residual print while retaining the scan's undisturbed pen and paper. */
export function refineQwenPrintedContours(
  source: Buffer,
  stencil: Uint8Array,
  prediction: Buffer,
  width: number,
  height: number,
): Buffer | undefined {
  const caption = refineQwenCaptionStock(
    source,
    prediction,
    stencil,
    width,
    height,
  );
  if (caption) return caption;
  const bounds = maskBoundsInRect(stencil, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  if (!bounds) return;
  const box = expandRect(bounds, width, height, 36);
  const offset = (i: number) =>
    ((box.y + Math.floor(i / box.w)) * width + box.x + (i % box.w)) * 4;
  const gray = new Uint8Array(box.w * box.h);
  const local = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const p = offset(i);
    gray[i] = Math.round(
      (29 * source[p] + 150 * source[p + 1] + 77 * source[p + 2]) / 256,
    );
    local[i] = Number(Boolean(stencil[p / 4]));
  }
  const dark = gray.map((v) => Number(v < 205));
  const ink = selectPrintedInk(dark, local, box.w, box.h);
  if (!ink) return;
  const { glyph } = ink;
  const distance = distanceToMask(glyph, box.w, box.h);
  const paper = measuredQwenPaper(
    { source, prediction, distance, offset, width: box.w, height: box.h },
    ink,
  );
  if (!paper) return;
  const { color, tolerance } = paper;
  const out = Buffer.from(source);
  for (let i = 0; i < glyph.length; i++) {
    if (distance[i] >= 2.9 || (dark[i] && !glyph[i])) continue;
    const p = offset(i);
    for (let c = 0; c < 3; c++) {
      const low = Math.max(0, color[c] - tolerance),
        high = Math.min(255, color[c] + tolerance);
      out[p + c] = Math.min(high, Math.max(low, prediction[p + c]));
    }
  }
  continueQwenPen({
    source,
    out,
    gray,
    distance,
    offset,
    width: box.w,
    height: box.h,
  });
  clearQwenPaperRinging(source, out, stencil, width, height);
  return out;
}

function measurePrintedRim(sample: PaperSample, glyph: Uint8Array) {
  const { prediction, distance, offset } = sample;
  const ring: number[] = [];
  let selected = 0,
    pale = 0;
  for (let i = 0; i < glyph.length; i++) {
    if (distance[i] > 2.4 && distance[i] < 5.6) ring.push(offset(i));
    if (!glyph[i]) continue;
    selected++;
    const p = offset(i);
    if (Math.min(prediction[p], prediction[p + 1], prediction[p + 2]) >= 236)
      pale++;
  }
  return { ring, selected, pale };
}

function measuredQwenPaper(
  sample: PaperSample,
  ink: NonNullable<ReturnType<typeof selectPrintedInk>>,
) {
  const { source } = sample;
  const { glyph, letters, nearbyLines, enclosedType } = ink;
  const { ring, selected, pale } = measurePrintedRim(sample, glyph);
  const measured = sampledRimColor(source, ring);
  if (!measured) return;
  const { color, clean } = measured;
  // Multiple disconnected strokes can share a compression fringe on paper.
  // Require the independently measured far bank when their near ring is noisy.
  if (clean.length < 0.9 * ring.length) return;
  if (letters > 1 || clean.length >= 0.95 * ring.length) {
    const outer = verifiedWhiteSurround(
      sample,
      nearbyLines,
      enclosedType && pale >= 0.8 * selected,
    );
    // A single connected shape can also be a drawn object. Require Qwen to
    // agree on its interior as well as on the surrounding scan.
    if (outer && (letters > 1 || pale >= 0.97 * selected))
      return { color: outer, tolerance: 0 };
  }
  if (
    clean.length >= 0.925 * ring.length &&
    letters > 1 &&
    pale >= 0.91 * selected
  )
    return { color, tolerance: 1 };
}

function sampledRimColor(source: Buffer, ring: number[]) {
  if (ring.length < 50) return;
  const color = [0, 1, 2].map((c) => {
    const values = Uint8Array.from(ring, (p) => source[p + c]).sort();
    return values[values.length >> 1];
  });
  if (Math.min(...color) < 239) return;
  const clean = ring.filter((p) =>
    color.every((v, c) => Math.abs(source[p + c] - v) < 9),
  );
  return { color, clean };
}

function whiteSurroundSamples(
  sample: PaperSample,
  nearbyLines: number[][],
  enclosedType: boolean,
) {
  const { distance, width, height } = sample;
  const samples: number[] = [];
  for (let i = 0; i < distance.length; i++)
    if (distance[i] >= 7 && distance[i] < 14) samples.push(i);
  if (samples.length < 80) return;
  // An original panel line can cross the sampling ring beside lettering.
  // Isolate it only when its native ink continues beyond the far bank.
  const pen = new Uint8Array(distance.length);
  for (const line of nearbyLines) {
    if (
      line.some((i) => distance[i] < 14) &&
      line.some((i) => distance[i] > 16)
    )
      for (const i of line) pen[i] = 1;
  }
  let ring = samples;
  if (pen.some(Boolean)) {
    const clearance = distanceToMask(pen, width, height);
    const clear = samples.filter((i) => clearance[i] > 4.5);
    const minimum = enclosedType ? 0.7 : 0.84;
    if (clear.length >= Math.max(80, minimum * samples.length)) ring = clear;
  }
  return ring;
}

function verifiedWhiteSurround(
  sample: PaperSample,
  nearbyLines: number[][],
  enclosedType: boolean,
) {
  const ring = whiteSurroundSamples(sample, nearbyLines, enclosedType);
  if (!ring) return;
  const { source, prediction, offset } = sample;
  const pixels = ring.map(offset);
  const color = [0, 1, 2].map((c) => {
    const values = Uint8Array.from(pixels, (p) => source[p + c]).sort();
    const mid = values[values.length >> 1];
    return mid >= 249 && values[Math.floor(0.025 * values.length)] >= mid - 4
      ? mid
      : -1;
  });
  if (color.includes(-1)) return;
  const agreed = pixels.filter((p) =>
    color.every((v, c) => Math.abs(prediction[p + c] - v) <= 8),
  );
  return agreed.length >= 0.965 * pixels.length ? color : undefined;
}

function selectPrintedInk(
  dark: Uint8Array,
  mask: Uint8Array,
  w: number,
  h: number,
) {
  const glyph = new Uint8Array(dark.length);
  const dots: Dot[] = [];
  const nearbyLines: number[][] = [];
  let enclosedType = false;
  let total = 0,
    explained = 0,
    letters = 0;
  for (const part of maskComponents(dark, w, h, 1)) {
    const { w: dw, h: dh } = part.rect;
    const { cells, owned, sx, sy } = measureOwnership(part, mask, w);
    if (enclosesSelectedInk(part, dark, mask, w, owned)) {
      nearbyLines.push(cells);
      enclosedType = true;
      continue;
    }
    total += owned;
    if (isUnselectedLine(part, owned)) nearbyLines.push(cells);
    if (touchesEdge(part.rect, w, h)) continue;
    const tiny = part.area <= 17 && Math.max(dw, dh) <= 6;
    if (tiny)
      dots.push({
        x: sx / part.area,
        y: sy / part.area,
        area: part.area,
        cells,
        owned: owned / part.area,
      });
    if (owned <= (tiny ? 0.35 : 0.5) * part.area) continue;
    for (const i of cells) glyph[i] = 1;
    explained += owned;
    letters += Number(Math.min(dw, dh) >= 6 && part.area >= 24);
  }
  if (!hasPrintedInk(letters, total, explained)) return;
  completeEllipsis(dots, glyph);
  return { glyph, letters, nearbyLines, enclosedType };
}

function isUnselectedLine(
  part: ReturnType<typeof maskComponents>[number],
  owned: number,
) {
  return (
    owned === 0 && Math.max(part.rect.w, part.rect.h) >= 8 && part.area >= 12
  );
}

function hasPrintedInk(letters: number, total: number, explained: number) {
  return letters >= 1 && total >= 48 && explained >= 0.94 * total;
}

function enclosesSelectedInk(
  part: ReturnType<typeof maskComponents>[number],
  dark: Uint8Array,
  stencil: Uint8Array,
  width: number,
  owned: number,
) {
  const { x, y, w, h } = part.rect;
  if (
    owned <= 0 ||
    owned >= 0.3 * part.area ||
    Math.min(w, h) < 24 ||
    part.area >= 0.24 * w * h
  )
    return false;
  const filled = fillEnclosedMaskHoles(part.data, w, h);
  const interior = new Uint8Array(filled.length);
  let space = 0;
  for (let i = 0; i < filled.length; i++) {
    if (!filled[i] || part.data[i]) continue;
    space++;
    const p = (y + Math.floor(i / w)) * width + x + (i % w);
    interior[i] = Number(Boolean(dark[p] && stencil[p]));
  }
  // On a little sound-effect balloon the stencil can clip its outline.
  // Require separate printed marks enclosed by substantial native paper.
  return (
    space >= 1.6 * part.area && maskComponents(interior, w, h, 6).length >= 2
  );
}

function completeEllipsis(dots: Dot[], glyph: Uint8Array) {
  const selected = dots.filter((dot) => dot.owned > 0.35);
  if (selected.length > 24 || dots.length > 256) return;
  // Native ellipses can end a few pixels outside a tightly segmented stroke.
  // Require two independently selected dots at the same spacing and angle.
  for (const a of selected)
    for (const b of selected) {
      const dx = b.x - a.x,
        dy = b.y - a.y,
        step = Math.hypot(dx, dy);
      if (step < 3 || step > 10) continue;
      const matches = dots.filter(
        (d) =>
          d.owned <= 0.35 &&
          Math.max(a.area, b.area, d.area) <=
            4 * Math.min(a.area, b.area, d.area) &&
          Math.hypot(d.x - b.x - dx, d.y - b.y - dy) <
            Math.max(1.2, 0.27 * step),
      );
      if (matches.length === 1)
        matches[0].cells.forEach((p) => {
          glyph[p] = 1;
        });
    }
}

function measureOwnership(
  part: ReturnType<typeof maskComponents>[number],
  mask: Uint8Array,
  w: number,
) {
  const { x, y, w: dw } = part.rect;
  const cells: number[] = [];
  let owned = 0,
    sx = 0,
    sy = 0;
  part.data.forEach((set, i) => {
    if (!set) return;
    const u = x + (i % dw),
      v = y + Math.floor(i / dw),
      p = v * w + u;
    cells.push(p);
    owned += mask[p];
    sx += u;
    sy += v;
  });
  return { cells, owned, sx, sy };
}

function touchesEdge(
  rect: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
) {
  return (
    rect.x === 0 ||
    rect.y === 0 ||
    rect.x + rect.w === width ||
    rect.y + rect.h === height
  );
}
