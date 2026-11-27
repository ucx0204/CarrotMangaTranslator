import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { recoverQwenPigment } from "./qwenPrintedPigment";
import { recoverQwenLuminousLettering } from "./qwenLuminousLettering";
import { measureSpotColourPrint } from "./qwenSpotColour";
import { maskComponents } from "./rasterMasks";

type Part = ReturnType<typeof maskComponents>[number];
type Disk = { x: number; y: number; radius: number };

/** A cover title can be a single OCR selection with no Koharu instance.
 * Recover a family of isolated, matte printed strokes with a pale outline.
 * Components touching the selection edge may be clothing or illustration. */
export function recoverQwenDisplayMask(
  bitmap: Buffer,
  size: { width: number; height: number },
  selection: PixelRect,
): (InpaintingWindowMask & { masthead?: true }) | undefined {
  if (
    selection.w < 0.31 * size.width ||
    selection.w < 1.4 * selection.h ||
    selection.h < 64 ||
    selection.w * selection.h > 1_400_000
  )
    return;
  const bounds = expandRect(selection, size.width, size.height, 2);
  const spot = measureSpotColourPrint(bitmap, size.width, bounds);
  if (spot) return { ...spot, masthead: true };
  const { w, h } = bounds;
  const tone = nativeLuminance(bitmap, size.width, bounds);
  const isolated = isolatedDisplayMask(tone, w, h);
  if (isolated) return { bounds, data: isolated };
  const pigment = recoverQwenPigment(tone, w, h);
  if (!pigment) return recoverQwenLuminousLettering(bitmap, size, selection);
  const distance = distanceToMask(pigment, w, h);
  const reach = pigmentShoulder(tone, distance, w, h);
  const data = pigment.map((set, i) =>
    Number(
      set || distance[i] <= 2.3 || (distance[i] <= reach && tone[i] >= 46),
    ),
  );
  return { bounds, data };
}

function pigmentShoulder(
  tone: Uint8Array,
  distance: Float32Array,
  w: number,
  h: number,
) {
  const cap = Math.max(6, Math.min(19, Math.round(0.1 * Math.min(w, h))));
  const deltas: number[] = [],
    widths: number[] = [];
  for (let y = 3; y < h - 3; y++)
    for (let x = 3; x < w - 3; x += 2) {
      const i = y * w + x;
      if (distance[i] < 0.9 || distance[i] > 1.5) continue;
      const gx = distance[i + 2] - distance[i - 2],
        gy = distance[i + 2 * w] - distance[i - 2 * w];
      const mag = Math.hypot(gx, gy);
      if (mag < 1) continue;
      const ray = readShoulderRay(
        tone,
        distance,
        w,
        h,
        x,
        y,
        gx / mag,
        gy / mag,
        cap,
      );
      if (!ray) continue;
      deltas.push(ray.delta);
      if (ray.width) widths.push(ray.width);
    }
  if (deltas.length < 25 || widths.length < 0.18 * deltas.length) return 2.5;
  deltas.sort((a, b) => a - b);
  if (
    deltas[Math.floor(deltas.length / 2)] < 7 &&
    widths.length < 0.31 * deltas.length
  )
    return 2.5;
  widths.sort((a, b) => a - b);
  return Math.min(cap, widths[Math.floor(0.8 * (widths.length - 1))] + 2);
}

function readShoulderRay(
  tone: Uint8Array,
  distance: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  cap: number,
) {
  const ray: number[] = [];
  for (let r = 1; r <= cap + 7; r++) {
    const xx = Math.round(x + r * dx),
      yy = Math.round(y + r * dy);
    if (Math.min(xx, yy, w - 1 - xx, h - 1 - yy) <= 0) return;
    const p = yy * w + xx;
    if (distance[p] < Math.min(7, r * 0.58)) return;
    ray.push(
      (4 * tone[p] + tone[p - 1] + tone[p + 1] + tone[p - w] + tone[p + w]) / 8,
    );
  }
  const end = ray.length - 1;
  const far = (ray[end] + ray[end - 2] + ray[end - 4]) / 3;
  if (far > 215) return;
  const near = (ray[1] + ray[2] + ray[3]) / 3,
    delta = near - far;
  let declines = 0,
    rises = 0,
    last = 2;
  for (let i = 2; i < cap; i++) {
    const diff = ray[i] - ray[i - 1];
    declines += Number(diff < -1.5);
    rises += Number(diff > 3);
    if (ray[i] - far > Math.max(4, delta * 0.1)) last = i + 2;
  }
  return {
    delta,
    width:
      delta > 12 && declines >= 0.22 * cap && rises < 0.34 * cap ? last : 0,
  };
}

function isolatedDisplayMask(tone: Uint8Array, w: number, h: number) {
  const dark = tone.map((v) => Number(v < 154));
  const thickness = distanceToMask(
    dark.map((v) => 1 - v),
    w,
    h,
  );
  const isolated = maskComponents(dark, w, h, 3).filter(
    ({ rect }) =>
      rect.x > 0 && rect.y > 0 && rect.x + rect.w < w && rect.y + rect.h < h,
  );
  const glyphs = isolated.filter((part) =>
    hasPrintedInterior(part, w, h, tone, thickness),
  );
  const large = glyphs.filter((p) => p.area >= 440);
  if (large.length < 5) return;
  const left = Math.min(...large.map((p) => p.rect.x));
  const right = Math.max(...large.map((p) => p.rect.x + p.rect.w));
  const total = glyphs.reduce((sum, part) => sum + part.area, 0);
  if (right - left < 0.62 * w || total < 0.06 * w * h || total > 0.46 * w * h)
    return;
  const core = new Uint8Array(dark.length);
  for (const part of glyphs) mergeMaskIntoPage(core, w, part.rect, part.data);
  for (const part of large) fillPrintedDisks(core, w, tone, part);
  // The finest dot in a printed accent may have only two dark samples.
  // Include its antialiasing before checking all three positions and sizes.
  const accents = maskComponents(
    tone.map((v) => Number(v < 185)),
    w,
    h,
    3,
  );
  addPrintedAccents(core, w, tone, accents);
  // Measure the bright shoulder outside the actual print. Low-luminance
  // ink beyond its antialiasing stays available to guide the reconstruction.
  const distance = distanceToMask(core, w, h);
  const edge = paperShoulder(
    distance,
    tone,
    Math.max(3, Math.min(18, Math.round(0.032 * h))),
  );
  if (!edge) return;
  const data = core.map((set, i) =>
    Number(set || distance[i] <= 2 || (distance[i] <= edge && tone[i] >= 152)),
  );
  return data;
}

function hasPrintedInterior(
  { rect, area, data }: Part,
  stride: number,
  height: number,
  tone: Uint8Array,
  thickness: Float32Array,
) {
  const { x, y, w, h } = rect;
  if (
    w < 10 ||
    h < 8 ||
    area > 0.39 * stride * height ||
    Math.max(w, h) > 0.67 * Math.max(stride, height)
  )
    return false;
  let interior = 0,
    smooth = 0,
    pale = 0,
    boundary = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const p = (y + Math.floor(i / w)) * stride + x + (i % w);
    if (thickness[p] > 3.1) {
      interior++;
      const gx =
        tone[p + 1 - stride] +
        2 * tone[p + 1] +
        tone[p + 1 + stride] -
        tone[p - 1 - stride] -
        2 * tone[p - 1] -
        tone[p - 1 + stride];
      const gy =
        tone[p + stride - 1] +
        2 * tone[p + stride] +
        tone[p + stride + 1] -
        tone[p - stride - 1] -
        2 * tone[p - stride] -
        tone[p - stride + 1];
      smooth += Number(gx * gx + gy * gy < 31 * 31);
    }
    if (thickness[p] <= 1) {
      boundary++;
      if (brightNeighbor(tone, p, stride)) pale++;
    }
  }
  return (
    interior > 0.12 * area && smooth > 0.47 * interior && pale > 0.63 * boundary
  );
}

function brightNeighbor(tone: Uint8Array, p: number, stride: number) {
  const x = p % stride;
  return (
    (x >= 2 && tone[p - 2] > 209) ||
    (x + 2 < stride && tone[p + 2] > 209) ||
    tone[p - 2 * stride] > 209 ||
    tone[p + 2 * stride] > 209
  );
}

/** Scan the observed top and bottom silhouette. A white character may open a
 * disk's counter to the exterior, so flood-filling holes loses some badges. */
function fillPrintedDisks(
  core: Uint8Array,
  stride: number,
  tone: Uint8Array,
  part: Part,
) {
  const candidates = scanDiskCenters(tone, stride, part);
  const disks: Disk[] = [];
  for (let i = 0; i < candidates.length;) {
    let end = i + 1;
    while (
      end < candidates.length &&
      candidates[end].x - candidates[end - 1].x <= 4
    )
      end++;
    disks.push(candidates[Math.floor((i + end - 1) / 2)]);
    i = end;
  }
  for (const disk of disks) {
    const peer = disks.some(
      (other) =>
        other !== disk &&
        Math.abs(disk.y - other.y) < 0.24 * disk.radius &&
        Math.abs(disk.radius - other.radius) < 0.16 * disk.radius &&
        Math.abs(disk.x - other.x) > 0.95 * (disk.radius + other.radius) &&
        Math.abs(disk.x - other.x) < 2.9 * disk.radius,
    );
    if (!peer) continue;
    const radius = disk.radius;
    for (
      let py = Math.max(0, Math.ceil(disk.y - radius));
      py <= Math.min(core.length / stride - 1, disk.y + radius);
      py++
    ) {
      const half = Math.sqrt(radius * radius - (py - disk.y) ** 2);
      core.fill(
        1,
        py * stride + Math.max(0, Math.ceil(disk.x - half)),
        py * stride + Math.min(stride, Math.floor(disk.x + half) + 1),
      );
    }
  }
}

function scanDiskCenters(tone: Uint8Array, stride: number, part: Part) {
  const { x, y, w, h } = part.rect;
  if (h < 25 || w < 1.65 * h || part.area < 0.38 * w * h) return [];
  const candidates: Disk[] = [];
  for (let col = 4; col < w - 4; col += 2) {
    let top = 0,
      bottom = h - 1;
    while (top < h && !part.data[top * w + col]) top++;
    while (bottom > top && !part.data[bottom * w + col]) bottom--;
    const radius = (bottom - top + 1) / 2;
    if (radius < 0.44 * h) continue;
    const cx = x + col,
      cy = y + (top + bottom) / 2;
    if (matchesNativeRim(tone, stride, cx, cy, radius))
      candidates.push({ x: cx, y: cy, radius });
  }
  return candidates;
}

function matchesNativeRim(
  tone: Uint8Array,
  stride: number,
  cx: number,
  cy: number,
  radius: number,
) {
  let votes = 0;
  for (let k = 0; k < 80; k++) {
    const angle = (k * Math.PI) / 40,
      dx = Math.cos(angle),
      dy = Math.sin(angle);
    const sample = (factor: number) =>
      tone[
        Math.round(cy + factor * radius * dy) * stride +
          Math.round(cx + factor * radius * dx)
      ] ?? 0;
    const inner = Math.min(sample(0.87), sample(0.94)),
      outer = Math.max(sample(1.06), sample(1.11));
    if (inner < 160 && outer > 209 && outer - inner > 61) votes++;
  }
  return votes >= 57;
}

function addPrintedAccents(
  core: Uint8Array,
  stride: number,
  tone: Uint8Array,
  parts: Part[],
) {
  const dist = distanceToMask(core, stride, core.length / stride);
  const dots = parts.flatMap((part) => {
    const { x, y, w, h } = part.rect;
    if (
      Math.min(w, h) < 2 ||
      Math.max(w, h) > 18 ||
      w / h < 0.5 ||
      w / h > 1.75 ||
      part.area < 0.51 * w * h
    )
      return [];
    const cx = x + (w - 1) / 2,
      cy = y + (h - 1) / 2;
    const p = Math.round(cy) * stride + Math.round(cx);
    if (dist[p] > Math.max(40, 0.06 * stride)) return [];
    return [{ part, x: cx, y: cy, size: Math.max(w, h), shade: tone[p] }];
  });
  for (const mid of dots) addAlignedDots(core, stride, mid, dots);
}

type Dot = { part: Part; x: number; y: number; size: number; shade: number };
function addAlignedDots(
  core: Uint8Array,
  stride: number,
  mid: Dot,
  dots: Dot[],
) {
  const near = dots.filter(
    (p) =>
      p !== mid &&
      Math.abs(p.shade - mid.shade) < 85 &&
      Math.hypot(p.x - mid.x, p.y - mid.y) <=
        3.5 * Math.max(mid.size, p.size) + 2,
  );
  for (const first of near.filter(
    (p) => p.part.area < mid.part.area && p.part.area * 8 >= mid.part.area,
  )) {
    const ax = mid.x - first.x,
      ay = mid.y - first.y,
      a = Math.hypot(ax, ay);
    if (a < mid.size) continue;
    for (const last of near.filter(
      (p) => p.part.area > mid.part.area && p.part.area <= 6 * mid.part.area,
    )) {
      const bx = last.x - mid.x,
        by = last.y - mid.y,
        b = Math.hypot(bx, by);
      if (b < 0.77 * a || b > 1.95 * a || ax * bx + ay * by < 0.94 * a * b)
        continue;
      for (const { part } of [first, mid, last])
        mergeMaskIntoPage(core, stride, part.rect, part.data);
    }
  }
}

function paperShoulder(
  dist: Float32Array,
  tone: Uint8Array,
  maxRadius: number,
) {
  const counts = new Uint32Array(maxRadius + 1),
    bright = new Uint32Array(maxRadius + 1);
  for (let i = 0; i < tone.length; i++) {
    const radius = Math.round(dist[i]);
    if (radius < 2 || radius > maxRadius) continue;
    counts[radius]++;
    if (tone[i] >= 241) bright[radius]++;
  }
  if (counts[3] < 80 || bright[3] < 0.8 * counts[3]) return 0;
  let edge = 3;
  while (
    edge < maxRadius &&
    bright[edge + 1] >= 0.88 * counts[edge + 1] &&
    counts[edge + 1] >= 60
  )
    edge++;
  return edge;
}
