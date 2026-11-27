import { addBracketedRule } from "./qwenPrintedDash";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { maskComponents } from "./rasterMasks";

type Part = ReturnType<typeof maskComponents>[number];
type Glyph = Part & { cx: number; cy: number; bank: number; radius: number };
type Print = { tone: Uint8Array; w: number; h: number; selection: PixelRect };

/** A family of matte white strokes with a dark outline. A lone star, reflection
 * or strip of white paper is insufficient evidence to change the selection. */
export function recoverQwenLuminousLettering(
  bitmap: Buffer,
  size: { width: number; height: number },
  selection: PixelRect,
): InpaintingWindowMask | undefined {
  const bounds = expandRect(
    selection,
    size.width,
    size.height,
    Math.round(0.22 * selection.h),
  );
  if (bounds.w * bounds.h > 850_000) return;
  const tone = nativeLuminance(bitmap, size.width, bounds);
  const field = {
    tone,
    w: bounds.w,
    h: bounds.h,
    selection: {
      ...selection,
      x: selection.x - bounds.x,
      y: selection.y - bounds.y,
    },
  };
  const parts = maskComponents(
    tone.map((v) => Number(v >= 229)),
    field.w,
    field.h,
    18,
  )
    .filter((p) => insideSelection(p, field))
    .map((p) => measureMatte(p, field))
    .filter((p): p is Glyph => !!p);
  const anchors = parts.filter((p) => anchorGlyph(p, selection.h));
  if (anchors.length < 5) return;
  const left = Math.min(...anchors.map((p) => p.rect.x));
  const right = Math.max(...anchors.map((p) => p.rect.x + p.rect.w));
  if (right - left < 0.56 * selection.w) return;
  const core = new Uint8Array(tone.length);
  for (const p of anchors) mergeMaskIntoPage(core, field.w, p.rect, p.data);
  addCompanions(parts, field, core);
  const stops = pairedStops(parts, selection.h);
  for (const [a, b] of stops) {
    mergeMaskIntoPage(core, field.w, a.rect, a.data);
    mergeMaskIntoPage(core, field.w, b.rect, b.data);
  }
  addFinePrint(field, core);
  const distance = distanceToMask(core, field.w, field.h);
  const rim = tone.map((v, i) =>
    Number(distance[i] <= 2.45 || (distance[i] <= 4.75 && v < 107)),
  );
  const data = Uint8Array.from(distanceToMask(rim, field.w, field.h), (d) =>
    Number(d < 1.5),
  );
  for (const [a, b] of stops) addBracketedRule(field, data, a, b);
  return { bounds, data };
}

function insideSelection(p: Part, field: Print) {
  const { x, y, w, h } = p.rect,
    box = field.selection;
  const cx = x + w / 2,
    cy = y + h / 2;
  return (
    x > 0 &&
    y > 0 &&
    x + w < field.w &&
    y + h < field.h &&
    cx > box.x &&
    cx < box.x + box.w &&
    cy >= box.y &&
    cy <= box.y + 1.11 * box.h &&
    plausibleSize(p, box)
  );
}

function plausibleSize({ rect: { w, h }, area }: Part, box: PixelRect) {
  const density = area / (w * h);
  return (
    h >= 0.06 * box.h &&
    h <= 0.91 * box.h &&
    w >= 0.045 * box.h &&
    w < 0.6 * box.w &&
    area > Math.max(28, 0.003 * box.h ** 2) &&
    density > 0.11 &&
    density < 0.93
  );
}

function percentile(values: number[], fraction: number) {
  values.sort((a, b) => a - b);
  return values[Math.round(fraction * (values.length - 1))];
}

function matteSamples(p: Part, field: Print) {
  const box = expandRect(p.rect, field.w, field.h, 6);
  const mask = new Uint8Array(box.w * box.h);
  mergeMaskIntoPage(
    mask,
    box.w,
    { ...p.rect, x: p.rect.x - box.x, y: p.rect.y - box.y },
    p.data,
  );
  const outer = distanceToMask(mask, box.w, box.h);
  const inner = distanceToMask(
    mask.map((v) => 1 - v),
    box.w,
    box.h,
  );
  const edge: number[] = [],
    near: number[] = [],
    face: number[] = [];
  let white = 0,
    samples = 0,
    radius = 0;
  for (let i = 0; i < mask.length; i++) {
    const v =
      field.tone[
        (box.y + Math.floor(i / box.w)) * field.w + box.x + (i % box.w)
      ];
    if (mask[i]) {
      face.push(v);
      radius = Math.max(radius, inner[i]);
      if (inner[i] > 1.5) {
        samples++;
        white += Number(v > 243);
      }
    } else if (outer[i] >= 1.3 && outer[i] < 3.65) {
      edge.push(v);
      if (outer[i] > 1.5 && outer[i] <= 2.5) near.push(v);
    }
  }
  return { face, edge, near, samples, white, radius };
}

function measureMatte(p: Part, field: Print): Glyph | undefined {
  const { face, edge, near, samples, white, radius } = matteSamples(p, field);
  const bank = percentile(edge, 0.55),
    thin = p.rect.w < 0.13 * field.selection.h;
  if (
    !samples ||
    white / samples <= (thin ? 0.68 : 0.78) ||
    percentile(face, 0.5) < 245
  )
    return;
  if (bank >= 124 && !(thin && percentile(near, 0.5) < 45)) return;
  return {
    ...p,
    cx: p.rect.x + p.rect.w / 2,
    cy: p.rect.y + p.rect.h / 2,
    bank,
    radius,
  };
}

function addFinePrint(field: Print, core: Uint8Array) {
  const reach = distanceToMask(core, field.w, field.h);
  for (const level of [198, 224, 176]) {
    const parts = maskComponents(
      field.tone.map((v) => Number(v >= level)),
      field.w,
      field.h,
      5,
    );
    for (const part of parts) {
      if (!finePrintSize(part, field)) continue;
      const distance = closestInk(part, reach, field.w);
      if (distance > 0.38 * field.selection.h) continue;
      const values = matteSamples(part, field);
      if (
        !hasDarkRim(values, distance, part, field.selection.h) &&
        !outlinedFace(part, field, values, distance)
      )
        continue;
      mergeMaskIntoPage(core, field.w, part.rect, part.data);
    }
  }
}

function finePrintSize(
  p: Part,
  { selection: box, w: width, h: height }: Print,
) {
  const { x, y, w, h } = p.rect;
  const cx = x + w / 2,
    cy = y + h / 2;
  return (
    x > 1 &&
    y > 1 &&
    x + w < width - 1 &&
    y + h < height - 1 &&
    cx >= box.x &&
    cx <= box.x + box.w &&
    cy >= box.y &&
    cy <= box.y + box.h &&
    Math.min(w, h) >= 2 &&
    Math.max(w, h) <= 0.84 * box.h &&
    p.area <= 0.31 * box.h ** 2
  );
}

function closestInk(p: Part, known: Float32Array, stride: number) {
  let distance = Infinity;
  p.data.forEach((set, i) => {
    if (set)
      distance = Math.min(
        distance,
        known[
          (p.rect.y + Math.floor(i / p.rect.w)) * stride +
            p.rect.x +
            (i % p.rect.w)
        ],
      );
  });
  return distance;
}

function hasDarkRim(
  values: ReturnType<typeof matteSamples>,
  distance: number,
  p: Part,
  h: number,
) {
  const { face, edge } = values;
  if (
    edge.length < 10 ||
    percentile(face, 0.5) < 229 ||
    percentile(face, 0.57) < 237 ||
    percentile(edge, 0.66) > 120
  )
    return false;
  if (distance === 0) return true;
  if (roundHighlight(p, h)) return false;
  return (
    clearFineStroke(distance, p, h) &&
    percentile(edge, 0.75) <= 106 &&
    (percentile(face, 0.6) > 244 || percentile(face, 0.5) >= 243)
  );
}

function roundHighlight(p: Part, h: number) {
  const ratio = p.rect.w / p.rect.h;
  return (
    ratio > 0.67 &&
    ratio < 1.45 &&
    p.area > 0.46 * p.rect.w * p.rect.h &&
    Math.max(p.rect.w, p.rect.h) < 0.125 * h
  );
}

function outlinedFace(
  p: Part,
  field: Print,
  values: ReturnType<typeof matteSamples>,
  distance: number,
) {
  const h = field.selection.h;
  if (
    roundHighlight(p, h) ||
    p.area < Math.max(14, 0.001 * h * h) ||
    distance > 0.36 * h
  )
    return false;
  if (
    percentile(values.face, 0.65) < 244 ||
    percentile(values.face, 0.35) < 218
  )
    return false;
  const { dark, measured } = countDarkEdges(p, field);
  return measured >= 12 && dark > 0.81 * measured;
}

function countDarkEdges(p: Part, field: Print) {
  const { w, h } = p.rect;
  let measured = 0,
    dark = 0;
  p.data.forEach((value, i) => {
    if (!value) return;
    const x = i % w,
      y = Math.floor(i / w);
    const at = (p.rect.y + y) * field.w + p.rect.x + x;
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]) {
      const nx = x + dx,
        ny = y + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && p.data[ny * w + nx])
        continue;
      const step = dx + dy * field.w;
      measured++;
      dark += Number(
        Math.min(field.tone[at + step], field.tone[at + 2 * step]) < 106,
      );
    }
  });
  return { measured, dark };
}

function clearFineStroke(distance: number, p: Part, h: number) {
  if (distance > 0.23 * h && Math.max(p.rect.w, p.rect.h) < 0.062 * h)
    return false;
  return (
    Math.min(p.rect.w, p.rect.h) >= 0.024 * h &&
    (p.area >= 0.0015 * h * h || distance <= 0.11 * h)
  );
}

function anchorGlyph(p: Glyph, h: number) {
  return (
    p.rect.h >= 0.175 * h &&
    p.rect.w >= 0.14 * h &&
    p.area >= Math.max(90, 0.008 * h * h) &&
    p.radius >= 2 &&
    p.bank < 99
  );
}

function addCompanions(parts: Glyph[], field: Print, core: Uint8Array) {
  const h = field.selection.h;
  const distance = distanceToMask(core, field.w, field.h);
  for (const p of parts) {
    if (
      p.rect.h >= 0.09 * h &&
      p.area > 50 &&
      (p.rect.h > 1.26 * p.rect.w || p.rect.w >= 0.2 * h) &&
      distance[Math.floor(p.cy) * field.w + Math.floor(p.cx)] < 0.26 * h
    )
      mergeMaskIntoPage(core, field.w, p.rect, p.data);
  }
}

function pairedStops(parts: Glyph[], h: number) {
  const dots = parts.filter(
    (p) =>
      p.rect.w <= 1.45 * p.rect.h &&
      p.rect.h > h / 23 &&
      parts.some(
        (s) =>
          s.rect.h > 1.2 * p.rect.h &&
          Math.abs(s.cx - p.cx) < 0.65 * p.rect.w &&
          p.cy - s.cy > 0.5 * p.rect.h &&
          p.cy - s.cy < 2.8 * p.rect.h,
      ),
  );
  const pairs: [Glyph, Glyph][] = [];
  for (const a of dots)
    for (const b of dots) if (adjacentStops(a, b)) pairs.push([a, b]);
  return pairs;
}

function adjacentStops(a: Glyph, b: Glyph) {
  return (
    b.cx - a.cx > a.rect.w &&
    b.cx - a.cx < 3.1 * a.rect.w &&
    Math.abs(b.cy - a.cy) < Math.max(3, 0.38 * a.rect.h) &&
    b.rect.w > 0.54 * a.rect.w &&
    b.rect.w < 1.7 * a.rect.w &&
    b.rect.h > 0.66 * a.rect.h &&
    b.rect.h < 1.4 * a.rect.h
  );
}
