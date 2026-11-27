import { smoothPrintTone } from "./qwenPrintTone";
import { knockoutRings, knockoutWidth } from "./qwenPrintedPigment";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { maskComponents } from "./rasterMasks";
import { measuredPrintedKeyline } from "./qwenPrintedKeyline";
import {
  hasPairedCreatorCredit,
  pairedCreatorBaselines,
} from "./qwenCreatorCaption";

type Component = ReturnType<typeof maskComponents>[number];
type Raster = {
  bounds: PixelRect;
  ink: Uint8Array;
  tone: Float32Array;
};
type Ray = { radius: number; horizontal: boolean; terminal: number };
type Anchor = { x: number; y: number; rays: Ray[] };
const scanLength = 32;

export function measureCreatorCaptions(
  bitmap: Buffer,
  size: { width: number; height: number },
  selection: PixelRect,
  reading: string,
  instance: InpaintingWindowMask,
) {
  if (
    !hasPairedCreatorCredit(reading) ||
    selection.h < 18 ||
    selection.h > 140 ||
    selection.w < 2 * selection.h
  )
    return;
  const bounds = expandRect(selection, size.width, size.height, 6);
  const tone = nativeTone(bitmap, size.width, bounds),
    ink = projectWindowMask(instance, bounds);
  const glyphs = maskComponents(
    Uint8Array.from(tone, (v) => Number(v < 155)),
    bounds.w,
    bounds.h,
    4,
  );
  return pairedCreatorBaselines({ bounds, tone, ink }, selection, glyphs);
}

/** Small credits may form a single joined detector region per printed line.
 * Measure the sharp pale shoulder around the independently registered letter
 * contours. Dark pen between the lines remains outside the returned mask. */
export function completeContextualCredit(
  bitmap: Buffer,
  size: { width: number; height: number },
  instance: InpaintingWindowMask,
) {
  const glow = measureQwenPrintGlow(bitmap, size, instance);
  if (glow) return glow;
  const bounds = expandRect(instance.bounds, size.width, size.height, 6);
  const ink = projectWindowMask(instance, bounds);
  const distance = distanceToMask(ink, bounds.w, bounds.h);
  const tone = nativeTone(bitmap, size.width, bounds);
  const rings = knockoutRings(tone, distance, bounds.w, {
    x: 0,
    y: 0,
    w: bounds.w,
    h: bounds.h,
  });
  const white = (samples: number[]) =>
    samples.filter((v) => v >= 235).length / Math.max(1, samples.length);
  const outer = white(rings[4].concat(rings[5], rings[6]));
  if (
    rings[1].length < 70 ||
    white(rings[1]) < Math.max(0.5, outer + 0.24) ||
    white(rings[2]) < outer + 0.12
  )
    return instance;
  return {
    bounds,
    data: ink.map((v, i) =>
      Number(v || (distance[i] <= 3.5 && tone[i] >= 145)),
    ),
  };
}

export function measureQwenSoundEffectKeyline(
  bitmap: Buffer,
  size: { width: number; height: number },
  instance: InpaintingWindowMask,
) {
  const bounds = expandRect(instance.bounds, size.width, size.height, 18);
  if (bounds.w * bounds.h > 1_500_000) return;
  return measuredPrintedKeyline(
    bounds,
    projectWindowMask(instance, bounds),
    nativeTone(bitmap, size.width, bounds),
    true,
  );
}

/** Measure the gradual white falloff of printed credits against the original
 * drawing. Require three separate glyphs in the same group to exhibit it. */
export function measureQwenPrintGlow(
  bitmap: Buffer,
  size: { width: number; height: number },
  instance: InpaintingWindowMask,
  ownedRegion?: InpaintingWindowMask,
): InpaintingWindowMask | undefined {
  const bounds = expandRect(
    instance.bounds,
    size.width,
    size.height,
    scanLength + 2,
  );
  if (bounds.w * bounds.h > 1_500_000) return;
  const ink = projectWindowMask(instance, bounds);
  const parts = maskComponents(ink, bounds.w, bounds.h, 9).filter(
    ({ rect }) =>
      Math.max(rect.w, rect.h) <= 66 && Math.min(rect.w, rect.h) >= 3,
  );
  if (parts.length < 3) {
    if (!ownedRegion)
      return measuredPrintedKeyline(
        bounds,
        ink,
        nativeTone(bitmap, size.width, bounds),
      );
    return;
  }
  const tone = nativeTone(bitmap, size.width, bounds);
  const raster = { bounds, ink, tone };
  if (ownedRegion) {
    const keyline = measuredSurround(raster, parts, true);
    if (keyline && followsPrintedRegion(raster, keyline, ownedRegion))
      return keyline;
    return;
  }
  return (
    measuredSurround(
      { ...raster, tone: smoothPrintTone(tone, bounds) },
      parts,
      false,
    ) ??
    measuredSurround(raster, parts, true) ??
    measuredPaleRings(raster, parts) ??
    measuredPrintedKeyline(bounds, ink, tone)
  );
}

function measuredPaleRings({ bounds, ink, tone }: Raster, parts: Component[]) {
  const distance = distanceToMask(ink, bounds.w, bounds.h);
  const radii: number[] = [];
  for (const part of parts) {
    const box = expandRect(part.rect, bounds.w, bounds.h, 13);
    const radius = knockoutWidth(knockoutRings(tone, distance, bounds.w, box));
    if (radius) radii.push(radius);
  }
  if (radii.length < Math.max(2, Math.ceil(0.6 * parts.length))) return;
  radii.sort((a, b) => a - b);
  const quarter = Math.floor(0.25 * (radii.length - 1));
  if (radii[radii.length - 1 - quarter] - radii[quarter] > 3) return;
  const reach = Math.min(
    10,
    radii[Math.floor(0.83 * (radii.length - 1))] + 1.4,
  );
  const data = ink.map((v, i) =>
    Number(v || (distance[i] <= reach && tone[i] >= 145)),
  );
  return { bounds, data };
}

/** Some layout masks follow the white outline of the letters themselves.
 * Require agreement with the independently measured print contour and a
 * textured exterior before treating the selected area as artwork. */
function followsPrintedRegion(
  { bounds, tone }: Raster,
  keyline: InpaintingWindowMask,
  owned: InpaintingWindowMask,
) {
  const region = projectWindowMask(owned, bounds);
  const count = (data: Uint8Array) => data.reduce((n, p) => n + Number(!!p), 0);
  const overlap = keyline.data.reduce(
    (n, p, i) => n + Number(!!p && !!region[i]),
    0,
  );
  if (
    overlap < 0.95 * count(owned.data) ||
    overlap < 0.78 * count(keyline.data)
  )
    return false;
  const distance = distanceToMask(region, bounds.w, bounds.h);
  let samples = 0,
    dark = 0,
    transitions = 0;
  for (let i = 0; i < distance.length; i++) {
    if (
      distance[i] < 1 ||
      distance[i] > 6 ||
      i % bounds.w === 0 ||
      region[i - 1]
    )
      continue;
    samples++;
    dark += Number(tone[i] < 150);
    transitions += Number(Math.abs(tone[i] - tone[i - 1]) > 22);
  }
  return samples >= 40 && dark > samples * 0.32 && transitions > samples * 0.14;
}

function measuredSurround(raster: Raster, parts: Component[], hard: boolean) {
  const { bounds, ink } = raster;
  const anchors: Anchor[] = [];
  for (const part of parts) {
    const rays = measureGlyph(raster, part, hard);
    if (rays.length < (hard ? 2 : 3)) continue;
    const first = part.data.findIndex(Boolean);
    anchors.push({
      x: part.rect.x + (first % part.rect.w),
      y: part.rect.y + Math.floor(first / part.rect.w),
      rays,
    });
  }
  if (anchors.length < 3) return;
  const radii = anchors
    .flatMap((a) => a.rays.map((v) => v.radius))
    .sort((a, b) => a - b);
  const radius =
    radii[Math.floor((radii.length - 1) * (hard ? 0.5 : 0.88))] +
    (hard ? 1 : 2);
  const distance = distanceToMask(ink, bounds.w, bounds.h);
  const field = Uint8Array.from(distance, (d) => Number(d <= radius));
  const data = new Uint8Array(ink.length);
  for (const { rect, data: group } of maskComponents(
    field,
    bounds.w,
    bounds.h,
    1,
  )) {
    const members = anchors.filter(
      ({ x, y }) =>
        x >= rect.x &&
        y >= rect.y &&
        x < rect.x + rect.w &&
        y < rect.y + rect.h &&
        group[(y - rect.y) * rect.w + x - rect.x],
    );
    if (members.length < 3 || (hard && !hasGlyphEdges(members))) continue;
    group.forEach((marked, i) => {
      if (marked)
        data[
          (rect.y + Math.floor(i / rect.w)) * bounds.w + rect.x + (i % rect.w)
        ] = 1;
    });
  }
  if (data.some(Boolean)) return { bounds, data };
}

function hasGlyphEdges(anchors: Anchor[]) {
  // A label on a white ribbon ends at the same straight artwork boundary
  // across many letters. A real keyline follows different glyph silhouettes.
  const horizontal = new Set<number>(),
    vertical = new Set<number>();
  for (const { rays } of anchors)
    for (const ray of rays)
      (ray.horizontal ? horizontal : vertical).add(
        Math.round(ray.terminal / 3),
      );
  return horizontal.size >= 4 && vertical.size >= 4;
}

function nativeTone(bitmap: Buffer, stride: number, box: PixelRect) {
  const gray = new Float32Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const p = ((box.y + y) * stride + box.x + x) * 4;
      gray[y * box.w + x] =
        (29 * bitmap[p] + 150 * bitmap[p + 1] + 77 * bitmap[p + 2]) / 256;
    }
  }
  return gray;
}

function measureGlyph(raster: Raster, part: Component, hard: boolean) {
  const rays: Ray[] = [];
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    for (
      let across = 0;
      across < (dx ? part.rect.h : part.rect.w);
      across += 2
    ) {
      const ray = measureFromEdge(raster, part, across, dx, dy, hard);
      if (ray) rays.push(ray);
    }
  }
  return rays;
}

function measureFromEdge(
  raster: Raster,
  { rect, data }: Component,
  across: number,
  dx: number,
  dy: number,
  hard: boolean,
) {
  const along = dx ? rect.w : rect.h;
  for (let pos = 0; pos < along; pos++) {
    const edge = dx + dy > 0 ? along - 1 - pos : pos;
    const x = dx ? edge : across;
    const y = dx ? across : edge;
    if (data[y * rect.w + x]) {
      const radius = rayRadius(raster, rect.x + x, rect.y + y, dx, dy, hard);
      if (radius)
        return {
          radius,
          horizontal: !!dx,
          terminal: dx ? rect.x + x + dx * radius : rect.y + y + dy * radius,
        };
      return;
    }
  }
}

function rayRadius(
  { bounds, ink, tone }: Raster,
  x: number,
  y: number,
  dx: number,
  dy: number,
  hard: boolean,
) {
  const length = hard ? 16 : scanLength;
  const endX = x + dx * length;
  const endY = y + dy * length;
  if (endX < 0 || endY < 0 || endX >= bounds.w || endY >= bounds.h) return;
  const values: number[] = [];
  for (let step = 1; step <= length; step++) {
    const i = (y + dy * step) * bounds.w + x + dx * step;
    if (ink[i]) return;
    values.push(tone[i]);
  }

  return hard ? keylineRadius(values) : falloffRadius(values);
}

function keylineRadius(values: number[]) {
  const edge = values.findIndex((value, i) => i >= 2 && value <= 150);
  if (edge < 2 || edge > 11) return;
  const shoulder = values.slice(0, edge),
    bank = values.slice(edge, edge + 4);
  if (
    shoulder.reduce((a, b) => a + b, 0) / shoulder.length >= 239 &&
    Math.max(...bank) <= 171 &&
    bank.reduce((a, b) => a + b, 0) / bank.length <= 107
  )
    return edge + 1;
}
function falloffRadius(values: number[]) {
  const bank = values.slice(23).sort((a, b) => a - b);
  const base = bank[4];
  if (255 - base < 46 || bank[8] - bank[0] > 15) return;
  const fraction = (i: number) =>
    ((values[i] + values[i + 1] + values[i + 2]) / 3 - base) / (255 - base);
  const near = fraction(0),
    mid = fraction(4),
    outer = fraction(9);
  if (near < 0.52 || mid < 0.24 || outer < 0.06) return;
  if (near - mid < 0.025 || mid - outer < 0.09 || outer - fraction(15) < 0.036)
    return;
  return monotoneRadius(values, base);
}

function monotoneRadius(values: number[], base: number) {
  for (let i = 3; i < 20; i++) if ((values[i] - values[i - 3]) / 3 > 4) return;
  const threshold = base + 0.035 * (255 - base);
  let radius = values.length;
  while (radius > 0 && values[radius - 1] <= threshold) radius--;
  if (radius <= 27) return radius;
}
