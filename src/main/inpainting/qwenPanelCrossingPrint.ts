import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { maskComponents } from "./rasterMasks";
import { trimWindowMask } from "./koharuTypographyMask";
type Part = ReturnType<typeof maskComponents>[number];

/** A letter can project out of a speech balloon, across a panel rule into the
 * white gutter. Its separate dark stroke and knockout are visible on both
 * banks of the same rule. Keep the complete mark in one model window. */
export function measurePanelCrossingPrint(
  bitmap: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  instance: InpaintingWindowMask,
) {
  if (
    rect.w < 17 ||
    rect.w > 120 ||
    rect.h < 38 ||
    rect.h > 230 ||
    rect.h < 1.2 * rect.w
  )
    return;
  const bounds = expandRect(rect, page.width, page.height, 36);
  const gray = nativeLuminance(bitmap, page.width, bounds);
  const selected = projectWindowMask(instance, bounds);
  const { ink, radii } = crossingInk(gray, bounds, rect, selected);
  if (!radii.length) return;
  radii.sort((a, b) => a - b);
  const radius = radii[Math.floor(0.8 * radii.length)] + 1.7;
  const distance = distanceToMask(ink, bounds.w, bounds.h);
  const paperInk = selectedPaperInk(
    gray,
    bounds,
    rect,
    selected,
    distance,
    radius,
  );
  const edge = distanceToMask(paperInk, bounds.w, bounds.h);
  // Reserve the complete antialiased stroke before a neighbouring dialogue
  // crop can claim its last pixels. Use the same edge for the Qwen reference.
  return trimWindowMask({
    bounds,
    data: Uint8Array.from(distance, (d, i) =>
      Number(
        d <= radius || (d <= radius + 1.5 && gray[i] > 205) || edge[i] <= 2.5,
      ),
    ),
  });
}

function crossingInk(
  gray: Uint8Array,
  bounds: PixelRect,
  rect: PixelRect,
  selected: Uint8Array,
) {
  const ink = new Uint8Array(gray.length);
  const radii: number[] = [];
  for (const part of maskComponents(
    gray.map((v) => Number(v < 128)),
    bounds.w,
    bounds.h,
    12,
  )) {
    const b = part.rect;
    if (!isCrossingStem(b, bounds, rect)) continue;
    const pageAt = (i: number) =>
      (b.y + Math.floor(i / b.w)) * bounds.w + b.x + (i % b.w);
    const overlap = part.data.reduce(
      (n, on, i) => n + Number(!!on && !!selected[pageAt(i)]),
      0,
    );
    if (overlap < 0.12 * part.area) continue;
    const shoulders = strokeShoulders(gray, bounds.w, part);
    if (shoulders.length < 4) continue;
    mergeMaskIntoPage(ink, bounds.w, b, part.data);
    radii.push(...shoulders);
  }
  return { ink, radii };
}

function isCrossingStem(b: PixelRect, bounds: PixelRect, rect: PixelRect) {
  return !(
    b.w > 81 ||
    b.h < 10 ||
    b.h > 91 ||
    b.y < 8 ||
    b.y + bounds.y < rect.y - 3 ||
    b.y + bounds.y > rect.y + 34 ||
    b.x + bounds.x < rect.x - 3 ||
    b.x + b.w + bounds.x > rect.x + rect.w + 3
  );
}

function strokeShoulders(gray: Uint8Array, w: number, part: Part) {
  const b = part.rect;
  const shoulders: number[] = [];
  for (let dy = 3; dy < Math.min(25, b.h - 5); dy++) {
    const row = part.data.subarray(dy * b.w, (dy + 1) * b.w);
    const l = row.indexOf(1),
      r = row.lastIndexOf(1);
    if (l < 0 || r - l > 18 || b.x + l < 20 || b.x + r + 20 >= w) continue;
    const y = b.y + dy;
    const left = crossingShoulder(gray, w, b.x + l, y, -1);
    const right = crossingShoulder(gray, w, b.x + r, y, 1);
    if (left && right) shoulders.push(left, right);
  }
  return shoulders;
}

function selectedPaperInk(
  gray: Uint8Array,
  bounds: PixelRect,
  rect: PixelRect,
  selected: Uint8Array,
  distance: Float32Array,
  radius: number,
) {
  const paperInk = new Uint8Array(gray.length);
  for (const part of maskComponents(
    gray.map((v) => Number(v < 155)),
    bounds.w,
    bounds.h,
    8,
  )) {
    const b = part.rect;
    if (
      b.x + bounds.x < rect.x - 2 ||
      b.y + bounds.y < rect.y - 2 ||
      b.x + bounds.x + b.w > rect.x + rect.w + 2 ||
      b.y + bounds.y + b.h > rect.y + rect.h + 2
    )
      continue;
    let selectedPixels = 0;
    part.data.forEach((on, i) => {
      if (!on) return;
      const p = (b.y + Math.floor(i / b.w)) * bounds.w + b.x + (i % b.w);
      selectedPixels += Number(!!selected[p] || distance[p] <= radius);
    });
    if (selectedPixels < 0.82 * part.area) continue;
    if (hasPaperBorder(gray, bounds, part))
      mergeMaskIntoPage(paperInk, bounds.w, b, part.data);
  }
  return paperInk;
}

function hasPaperBorder(gray: Uint8Array, bounds: PixelRect, part: Part) {
  const b = part.rect;
  let samples = 0,
    pale = 0;
  const surround = expandRect(b, bounds.w, bounds.h, 4);
  const sampleMask = new Uint8Array(surround.w * surround.h);
  mergeMaskIntoPage(
    sampleMask,
    surround.w,
    {
      ...b,
      x: b.x - surround.x,
      y: b.y - surround.y,
    },
    part.data,
  );
  distanceToMask(sampleMask, surround.w, surround.h).forEach((d, i) => {
    if (d < 2 || d > 3.85) return;
    const x = surround.x + (i % surround.w);
    const y = surround.y + Math.floor(i / surround.w);
    samples++;
    pale += Number(gray[y * bounds.w + x] > 236);
  });
  return samples >= 10 && pale >= 0.86 * samples;
}

function crossingShoulder(
  gray: Uint8Array,
  w: number,
  x: number,
  y: number,
  sign: number,
) {
  let dark = 0,
    paper = 0;
  for (let d = 7; d <= 19; d++) {
    const i = y * w + x + sign * d;
    dark += Number(gray[i] < 105) + Number(gray[i + w] < 105);
    for (let up = 6; up <= 8; up++) paper += Number(gray[i - up * w] > 228);
  }
  if (dark < 0.63 * 26 || paper < 0.7 * 39) return;
  const rim = Array.from(
    { length: 7 },
    (_, j) => gray[y * w + x + sign * (j + 1)],
  );
  if (
    rim.filter((v) => v > 210).length < 2 ||
    Math.max(...rim.slice(1, 5)) < 239
  )
    return;
  const end = rim.reduce((v, level, j) => (level > 175 ? j + 1 : v), 0);
  return end >= 2 && end <= 6 ? end : undefined;
}

/** At the foot of a handwritten column, register both detached stops of !?
 * to the last inked rows of their respective stems. */
export function completePairedStops(
  bitmap: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  selected: InpaintingWindowMask,
) {
  if (rect.w > 110 || rect.h < 36 || rect.h < 1.4 * rect.w) return;
  const h = Math.min(rect.h, Math.max(28, Math.round(0.65 * rect.w)));
  const bounds = expandRect(
    { ...rect, y: rect.y + rect.h - h, h },
    page.width,
    page.height,
    3,
  );
  const gray = nativeLuminance(bitmap, page.width, bounds);
  const stencil = projectWindowMask(selected, bounds);
  const parts = maskComponents(
    gray.map((v) => Number(v < 182)),
    bounds.w,
    bounds.h,
    3,
  );
  const stops = pairedStemStops(parts, stencil, bounds);
  if (stops.length !== 2 || stops[0].dot === stops[1].dot) return;
  const [a, b] = stops;
  const dx = Math.abs(a.dot.rect.x - b.dot.rect.x),
    scale = Math.max(a.stem.h, b.stem.h);
  if (
    dx < 3 ||
    dx > scale ||
    Math.abs(a.dot.rect.y - b.dot.rect.y) > 0.45 * scale ||
    Math.abs(a.stem.y - b.stem.y) > 0.42 * scale
  )
    return;
  const dots = new Uint8Array(gray.length);
  for (const { dot } of stops)
    mergeMaskIntoPage(dots, bounds.w, dot.rect, dot.data);
  const distance = distanceToMask(dots, bounds.w, bounds.h);
  return trimWindowMask({
    bounds,
    data: Uint8Array.from(distance, (d) => Number(d <= 2)),
  });
}

function pairedStemStops(
  parts: Part[],
  stencil: Uint8Array,
  bounds: PixelRect,
) {
  const stops = [];
  for (const stem of parts) {
    const b = stem.rect;
    if (!isStopStem(b, bounds)) continue;
    const cx = selectedStemTip(stem, stencil, bounds);
    if (cx === undefined) continue;
    const dots = parts.filter(({ rect: d, area }) => {
      const gap = d.y - b.y - b.h;
      return (
        gap >= 1 &&
        gap <= Math.max(3.5, 0.48 * b.w) &&
        d.h >= 2 &&
        d.h <= 0.54 * b.h &&
        d.w <= Math.max(3, 0.72 * b.w) &&
        d.w >= 0.5 * d.h &&
        d.w <= 1.6 * d.h &&
        area >= 0.48 * d.w * d.h &&
        Math.abs(d.x + (d.w - 1) / 2 - cx) <= Math.max(2, 0.35 * b.w)
      );
    });
    if (dots.length === 1) stops.push({ stem: b, dot: dots[0] });
  }
  return stops;
}

function isStopStem(b: PixelRect, bounds: PixelRect) {
  return !(
    b.h < 6 ||
    b.h > 32 ||
    b.w < 2 ||
    b.h < 1.3 * b.w ||
    b.y + b.h < 0.36 * bounds.h ||
    b.y + b.h > bounds.h - 3
  );
}

function selectedStemTip(stem: Part, stencil: Uint8Array, bounds: PixelRect) {
  const b = stem.rect;
  let owned = 0,
    tip = 0,
    samples = 0;
  stem.data.forEach((on, i) => {
    if (!on) return;
    const x = b.x + (i % b.w),
      y = b.y + Math.floor(i / b.w);
    owned += Number(!!stencil[y * bounds.w + x]);
    if (y >= b.y + b.h - 2) {
      tip += x;
      samples++;
    }
  });
  if (owned >= 0.58 * stem.area && samples) return tip / samples;
}
