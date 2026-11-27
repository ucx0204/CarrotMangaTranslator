import type { NativeImage } from "electron";
import { maskBoundsInRect } from "./imageRaster";
import { fillEnclosedMaskHoles } from "../bubbleLayout/bubbleMaskComponents";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { maskComponents } from "./rasterMasks";

type Part = ReturnType<typeof maskComponents>[number];
type Field = { tone: Uint8Array; distance: Float32Array; w: number; h: number };

/** A single connected white keyline can enclose an entire vertical title.
 * Check the enclosed dark glyphs in two separately selected columns before
 * extending the detector mask to the printed outer edge. */
export function completeOutlinedColumns(
  bitmap: Buffer,
  size: { width: number; height: number },
  instance: InpaintingWindowMask,
  selected = instance.bounds,
): InpaintingWindowMask | undefined {
  if (
    selected.h < 150 ||
    selected.w < 60 ||
    selected.h < 1.06 * selected.w ||
    selected.w * selected.h > 900_000
  )
    return;
  const bounds = expandRect(selected, size.width, size.height, 30);
  const owned = projectWindowMask(instance, bounds);
  const field = {
    tone: nativeLuminance(bitmap, size.width, bounds),
    distance: distanceToMask(owned, bounds.w, bounds.h),
    w: bounds.w,
    h: bounds.h,
  };
  const parts = maskComponents(
    field.tone.map((v) => Number(v >= 226)),
    bounds.w,
    bounds.h,
    5,
  ).filter((p) => contained(p.rect, field));
  const columns = parts.filter(
    (p) => columnShape(p.rect, selected) && printedColumn(p, field),
  );
  if (!columns.some((a) => columns.some((b) => neighboring(a.rect, b.rect))))
    return;
  const complete = owned.slice();
  for (const part of parts) {
    if (
      !onSelectedInk(part, field, 0.26) ||
      darkBoundary(part, field, 190) < 0.47
    )
      continue;
    mergeMaskIntoPage(
      complete,
      bounds.w,
      part.rect,
      fillEnclosedMaskHoles(part.data, part.rect.w, part.rect.h),
    );
  }
  const core = dilateBinaryMaskDisk(complete, bounds.w, bounds.h, 3);
  addShadedTerminals(core, field);
  return { bounds, data: completeBrightRims(core, field) };
}

// Saturated outlines can merge with a light fold of the illustration at
// lower thresholds. Locate the same attached ink at the bright end of the scan.
function completeBrightRims(core: Uint8Array, field: Field) {
  const distance = distanceToMask(core, field.w, field.h);
  const extensions = new Uint8Array(core.length);
  for (const level of [242, 250]) {
    const pieces = maskComponents(
      field.tone.map((v) => Number(v >= level)),
      field.w,
      field.h,
      12,
    );
    for (const p of pieces) {
      if (p.rect.w > 118 || p.rect.h > 420 || Math.min(p.rect.w, p.rect.h) < 3)
        continue;
      const fill = attachedBrightRim(p, field, distance);
      if (fill) mergeMaskIntoPage(extensions, field.w, p.rect, fill);
    }
  }
  if (!extensions.some(Boolean)) return core;
  const fringe = distanceToMask(extensions, field.w, field.h);
  return core.map((v, i) => Number(v || fringe[i] < 2.6));
}

function attachedBrightRim(p: Part, field: Field, distance: Float32Array) {
  let inside = 0,
    near = 0,
    beyond = 0,
    farthest = 0;
  p.data.forEach((v, i) => {
    if (!v) return;
    const d = distance[offset(p.rect, i, field.w)];
    inside += Number(d === 0);
    near += Number(d <= 1);
    beyond += Number(d > 15);
    farthest = Math.max(farthest, d);
  });
  if (
    inside < 0.59 * p.area ||
    p.area - inside < 3 ||
    beyond > 0.025 * p.area ||
    farthest > 24
  )
    return;
  const fill = fillEnclosedMaskHoles(p.data, p.rect.w, p.rect.h);
  const letters = fill.reduce(
    (n, v, i) =>
      n +
      Number(v && !p.data[i] && field.tone[offset(p.rect, i, field.w)] < 140),
    0,
  );
  if (letters >= 6 || (p.rect.w < 38 && p.rect.h < 48 && near > 0.75 * p.area))
    return fill;
}

export function hasOutlinedColumns(source: NativeImage, stencil: Uint8Array) {
  const size = source.getSize();
  if (size.height < 150 || size.width < 60 || stencil.length > 950_000)
    return false;
  const bounds = { x: 0, y: 0, w: size.width, h: size.height };
  const selected = maskBoundsInRect(stencil, size.width, bounds);
  if (!selected) return false;
  return !!completeOutlinedColumns(
    source.toBitmap(),
    size,
    { bounds, data: stencil },
    selected,
  );
}

function contained(r: PixelRect, f: Field) {
  return Math.min(r.x, r.y, f.w - r.x - r.w, f.h - r.y - r.h) > 3;
}

function columnShape(r: PixelRect, selected: PixelRect) {
  return (
    r.w >= 14 &&
    r.h >= Math.max(78, 0.28 * selected.h) &&
    r.h > 1.75 * r.w &&
    r.w < 0.82 * selected.w &&
    r.h < selected.h + 33
  );
}

function neighboring(a: PixelRect, b: PixelRect) {
  return (
    Math.abs(a.x + a.w / 2 - b.x - b.w / 2) > 0.62 * Math.min(a.w, b.w) &&
    Math.max(a.y, b.y) + Math.max(35, 0.18 * Math.min(a.h, b.h)) <
      Math.min(a.y + a.h, b.y + b.h)
  );
}

function offset(r: PixelRect, i: number, stride: number) {
  return (r.y + Math.floor(i / r.w)) * stride + r.x + (i % r.w);
}

function onSelectedInk(p: Part, f: Field, nearFraction: number) {
  let close = 0,
    distant = 0;
  p.data.forEach((set, i) => {
    if (!set) return;
    const distance = f.distance[offset(p.rect, i, f.w)];
    close += Number(distance <= 3.5);
    distant += Number(distance > 23);
  });
  return close >= nearFraction * p.area && distant <= 0.03 * p.area;
}

function darkBoundary(p: Part, f: Field, level: number, covered?: Uint8Array) {
  const radius = covered ? 3.1 : 2.85;
  const r = expandRect(p.rect, f.w, f.h, Math.ceil(radius));
  const mask = new Uint8Array(r.w * r.h);
  mergeMaskIntoPage(
    mask,
    r.w,
    { ...p.rect, x: p.rect.x - r.x, y: p.rect.y - r.y },
    p.data,
  );
  const distance = distanceToMask(mask, r.w, r.h);
  let total = 0,
    dark = 0;
  distance.forEach((v, i) => {
    const pos = offset(r, i, f.w);
    if (v <= 0 || v > radius || covered?.[pos]) return;
    total++;
    dark += Number(f.tone[pos] < level);
  });
  return total >= 12 ? dark / total : 0;
}

function printedColumn(p: Part, f: Field) {
  if (!onSelectedInk(p, f, 0.43) || darkBoundary(p, f, 190) < 0.73)
    return false;
  const fill = fillEnclosedMaskHoles(p.data, p.rect.w, p.rect.h);
  const enclosed = fill.map((v, i) =>
    Number(v && !p.data[i] && f.tone[offset(p.rect, i, f.w)] < 80),
  );
  const cores = maskComponents(enclosed, p.rect.w, p.rect.h, 9).filter(
    (v) => v.rect.w >= 2 && v.rect.h >= 3,
  );
  return (
    cores.length >= 5 &&
    enclosed.reduce((n, v) => n + v, 0) >=
      0.07 * fill.reduce((n, v) => n + v, 0)
  );
}

function addShadedTerminals(core: Uint8Array, f: Field) {
  const distance = distanceToMask(core, f.w, f.h);
  const pieces = maskComponents(
    f.tone.map((v, i) => Number(v > 22 && !core[i])),
    f.w,
    f.h,
    240,
  );
  for (const p of pieces) {
    if (
      !contained(p.rect, f) ||
      p.area > 3500 ||
      Math.max(p.rect.w, p.rect.h) > 88
    )
      continue;
    const values: number[] = [],
      reach: number[] = [];
    let attached = 0;
    p.data.forEach((marked, i) => {
      if (!marked) return;
      const pos = offset(p.rect, i, f.w);
      values.push(f.tone[pos]);
      reach.push(distance[pos]);
      attached += Number(distance[pos] < 2.15);
    });
    values.sort((a, b) => a - b);
    reach.sort((a, b) => a - b);
    if (
      attached < Math.max(5, 0.12 * (p.rect.w + p.rect.h)) ||
      reach[reach.length - 1] > 41 ||
      reach[Math.floor(0.94 * (reach.length - 1))] > 30 ||
      values[Math.floor(0.75 * (values.length - 1))] -
        values[Math.floor(0.25 * (values.length - 1))] <
        40
    )
      continue;
    if (darkBoundary(p, f, 16, core) < 0.72) continue;
    mergeMaskIntoPage(
      core,
      f.w,
      p.rect,
      fillEnclosedMaskHoles(p.data, p.rect.w, p.rect.h),
    );
  }
}

/** Mixed light and dark publisher lettering can share a broad shadow with
 * smaller, pale type between the main glyphs. Measure both printing styles
 * independently on the selected original before completing that shadow. */
export function completeLayeredDisplayTitle(
  bitmap: Buffer,
  size: { width: number; height: number },
  instance: InpaintingWindowMask,
  selected: PixelRect,
): InpaintingWindowMask | undefined {
  if (
    selected.w < 360 ||
    selected.h < 125 ||
    selected.w < 1.5 * selected.h ||
    selected.w > 5.8 * selected.h ||
    selected.w * selected.h > 850_000
  )
    return;
  const bounds = expandRect(selected, size.width, size.height, 24);
  const owned = projectWindowMask(instance, bounds);
  if (owned.reduce((sum, value) => sum + Number(!!value), 0) < 14_500) return;
  const original = maskBoundsInRect(owned, bounds.w, {
    x: 0,
    y: 0,
    w: bounds.w,
    h: bounds.h,
  });
  if (!original) return;
  const field = {
    tone: nativeLuminance(bitmap, size.width, bounds),
    distance: distanceToMask(owned, bounds.w, bounds.h),
    w: bounds.w,
    h: bounds.h,
  };
  const ink = layeredGlyphSizes(field, selected.h, false);
  if (ink.length < 3) return;
  const paper = layeredGlyphSizes(field, selected.h, true);
  if (paper.length < 2) return;
  const sizes = [...ink, ...paper].sort((a, b) => a - b);
  const radius = Math.min(
    22,
    Math.max(8, Math.round(sizes[Math.floor(sizes.length / 2)] * 0.27)),
  );
  const pale = paleTypeBetweenGlyphs(field, radius);
  for (const part of maskComponents(pale, bounds.w, bounds.h, 5)) {
    if (isSmallPaleGlyph(part, field))
      mergeMaskIntoPage(owned, bounds.w, part.rect, part.data);
  }
  const distance = distanceToMask(owned, bounds.w, bounds.h);
  const envelope = expandRect(original, bounds.w, bounds.h, radius);
  return {
    bounds,
    data: Uint8Array.from(distance, (v, i) => {
      const x = i % bounds.w,
        y = Math.floor(i / bounds.w);
      return Number(
        v <= radius &&
          x >= envelope.x &&
          x < envelope.x + envelope.w &&
          y >= envelope.y &&
          y < envelope.y + envelope.h,
      );
    }),
  };
}

function layeredGlyphSizes(f: Field, height: number, light: boolean) {
  const ink = f.tone.map((v) => Number(light ? v > 221 : v < 105));
  const sizes: number[] = [];
  for (const p of maskComponents(ink, f.w, f.h, 170)) {
    const { w, h } = p.rect;
    const span = Math.max(w, h);
    if (
      !contained(p.rect, f) ||
      Math.min(w, h) < 13 ||
      span < 31 ||
      span > 0.8 * height ||
      p.area > 8200 ||
      !onSelectedInk(p, f, 0.55)
    )
      continue;
    const dark = darkBoundary(p, f, light ? 119 : 216);
    if ((light ? dark : 1 - dark) < 0.55) continue;
    if (singleInkLevel(p, f)) sizes.push(span);
  }
  return sizes;
}

function singleInkLevel(p: Part, f: Field) {
  const inside = distanceToMask(
    p.data.map((v) => Number(!v)),
    p.rect.w,
    p.rect.h,
  );
  const hist = new Uint32Array(256);
  let samples = 0;
  p.data.forEach((on, i) => {
    if (!on || inside[i] < 2.2) return;
    hist[f.tone[offset(p.rect, i, f.w)]]++;
    samples++;
  });
  let mass = 0,
    peak = 0;
  hist.forEach((count, i) => {
    mass += count - (hist[i - 11] ?? 0);
    peak = Math.max(peak, mass);
  });
  return samples >= 40 && peak >= 0.69 * samples;
}

function paleTypeBetweenGlyphs(f: Field, radius: number) {
  const result = new Uint8Array(f.tone.length);
  for (let y = 4; y < f.h - 4; y++) {
    for (let x = 4; x < f.w - 4; x++) {
      const i = y * f.w + x,
        v = f.tone[i];
      if (v < 65 || v > 215 || f.distance[i] > 4.5 * radius) continue;
      result[i] = Number(surroundingTone(f, i) - v > 10);
    }
  }
  return result;
}

function surroundingTone(f: Field, i: number) {
  let sum = 0;
  for (let dy = -4; dy <= 4; dy += 2)
    for (let dx = -4; dx <= 4; dx += 2) sum += f.tone[i + dy * f.w + dx];
  return sum / 25;
}

function isSmallPaleGlyph(p: Part, f: Field) {
  const { w, h } = p.rect;
  return (
    p.area <= 950 &&
    w <= 48 &&
    h >= 2 &&
    h <= 41 &&
    Math.max(w, h) >= 4 &&
    p.area <= 0.91 * w * h &&
    darkBoundary(p, f, 229) < 0.31
  );
}
