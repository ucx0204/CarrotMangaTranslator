import { solveLinearSystem } from "../../shared/thinPlateSpline";
import { distanceToMask } from "./pageMaskComposite";
import { maskComponents } from "./rasterMasks";
import type { PixelRect } from "./maskGeometry";

/** Optical distances and connected pigments measured on one native pixel grid. */
export function printMaskGrid(width: number, height: number) {
  return {
    distance: (ink: Uint8Array) => distanceToMask(ink, width, height),
    components: (ink: Uint8Array, minimum: number) =>
      maskComponents(ink, width, height, minimum),
  };
}

type Sample = { basis: number[]; level: number };
type Pigment = { points: number[]; samples: Sample[]; center: number };

function basis(x: number, y: number) {
  return [
    1,
    x,
    y,
    x * x,
    x * y,
    y * y,
    x * x * x,
    x * x * y,
    x * y * y,
    y * y * y,
  ];
}
function at(coef: number[], terms: number[]) {
  let sum = 0;
  for (let i = 0; i < terms.length; i++) sum += coef[i] * terms[i];
  return sum;
}
const regularization = [
  0.0001, 0.02, 0.02, 0.06, 0.06, 0.06, 0.1, 0.1, 0.1, 0.1,
];
function surface(groups: readonly Pigment[]) {
  const matrix = regularization.map((v, i) =>
    regularization.map((_, j) => (i === j ? v : 0)),
  );
  const right = Array<number>(10).fill(0);
  for (const { basis: terms, level } of groups.flatMap(
    (group) => group.samples,
  )) {
    for (let i = 0; i < 10; i++) {
      right[i] += terms[i] * level;
      for (let j = 0; j <= i; j++) matrix[i][j] += terms[i] * terms[j];
    }
  }
  for (let i = 0; i < 10; i++)
    for (let j = 0; j < i; j++) matrix[j][i] = matrix[i][j];
  return solveLinearSystem(matrix, right);
}
function groupError(group: Pigment, coef: number[]) {
  const residuals = group.samples
    .map((s) => Math.abs(at(coef, s.basis) - s.level))
    .sort((a, b) => a - b);
  return residuals[Math.floor(residuals.length / 2)];
}

/** Dark gradient lettering shares one smooth printed colour field across
 * otherwise disconnected characters. Give each character the same vote. */
export function recoverQwenPigment(tone: Uint8Array, w: number, h: number) {
  const seeds = flatPigmentSeeds(tone, w, h);
  const groups: Pigment[] = [];
  for (const part of seeds) {
    const c = part.rect;
    if (c.x <= 1 || c.y <= 1 || c.x + c.w >= w - 1 || c.y + c.h >= h - 1)
      continue;
    if (Math.min(c.w, c.h) < 3 || part.area > 0.3 * w * h) continue;
    const group = measurePigment(part, tone, w, h);
    if (group) groups.push(group);
  }
  const voters = groups.filter((g) => g.samples.length > 0);
  if (voters.length < 5 || voters.length > 320) return;
  const coef = sharedPigmentSurface(voters, w);
  if (!coef) return;
  return applyPigmentSurface(groups, coef, tone, w, h);
}

function flatPigmentSeeds(tone: Uint8Array, w: number, h: number) {
  const flat = new Uint8Array(tone.length);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (tone[p] > 5 && tone[p] < 162 && neighborhoodRange(tone, w, p) < 15)
        flat[p] = 1;
    }
  return maskComponents(flat, w, h, 19);
}

function neighborhoodRange(tone: Uint8Array, stride: number, p: number) {
  let lo = 255,
    hi = 0;
  for (const row of [p - stride, p, p + stride]) {
    lo = Math.min(lo, tone[row - 1], tone[row], tone[row + 1]);
    hi = Math.max(hi, tone[row - 1], tone[row], tone[row + 1]);
  }
  return hi - lo;
}
function positions(rect: PixelRect, mask: Uint8Array, stride: number) {
  const points: number[] = [];
  for (let j = 0; j < mask.length; j++) {
    if (mask[j])
      points.push(
        (rect.y + Math.floor(j / rect.w)) * stride + rect.x + (j % rect.w),
      );
  }
  return points;
}

function measurePigment(
  part: ReturnType<typeof maskComponents>[number],
  tone: Uint8Array,
  w: number,
  h: number,
): Pigment | undefined {
  const { rect } = part;
  const sx = Math.max(0, rect.x - 6),
    sy = Math.max(0, rect.y - 6);
  const box = {
    x: sx,
    y: sy,
    w: Math.min(w, rect.x + rect.w + 6) - sx,
    h: Math.min(h, rect.y + rect.h + 6) - sy,
  };
  const seeds = positions(rect, part.data, w);
  const levels = seeds.map((i) => tone[i]).sort((a, b) => a - b);
  const level = levels[Math.floor(levels.length / 2)];
  if (level < 10 || level > 153) return;
  const shape = new Uint8Array(box.w * box.h);
  for (const p of seeds) addPigmentRim(shape, box, p, tone, w);
  const near = distanceToMask(shape, box.w, box.h);
  const interior = distanceToMask(
    shape.map((v) => 1 - v),
    box.w,
    box.h,
  );
  const sampleIndices: number[] = [];
  let margin = 0,
    contrast = 0,
    thickness = 0;
  for (let i = 0; i < shape.length; i++) {
    const p = (sy + Math.floor(i / box.w)) * w + sx + (i % box.w);
    thickness = Math.max(thickness, interior[i]);
    if (interior[i] >= 2.5) sampleIndices.push(p);
    if (near[i] >= 1.5 && near[i] < 5) {
      margin++;
      contrast += Number(Math.abs(tone[p] - level) > 45);
    }
  }
  if (thickness < 1.9 || contrast < 0.56 * margin || margin < 8) return;
  const points = positions(box, shape, w);
  if (points.length < Math.max(45, 0.061 * rect.w * rect.h)) return;
  return {
    points,
    center: rect.x + rect.w / 2,
    samples: samplePigment(sampleIndices, tone, w, h),
  };
}

function addPigmentRim(
  shape: Uint8Array,
  box: PixelRect,
  p: number,
  tone: Uint8Array,
  stride: number,
) {
  const y = Math.floor(p / stride),
    x = p % stride;
  for (
    let yy = Math.max(box.y, y - 3);
    yy <= Math.min(box.y + box.h - 1, y + 3);
    yy++
  ) {
    const half = Math.floor(Math.sqrt(12 - (yy - y) ** 2));
    for (
      let xx = Math.max(box.x, x - half);
      xx <= Math.min(box.x + box.w - 1, x + half);
      xx++
    ) {
      if (Math.abs(tone[yy * stride + xx] - tone[p]) < 30)
        shape[(yy - box.y) * box.w + xx - box.x] = 1;
    }
  }
}

function samplePigment(
  indices: number[],
  tone: Uint8Array,
  w: number,
  h: number,
): Sample[] {
  if (indices.length < 6) return [];
  return Array.from({ length: 21 }, (_, j) => {
    const i = indices[Math.floor(((j + 0.5) * indices.length) / 21)];
    return {
      basis: basis(
        (2 * (i % w)) / (w - 1) - 1,
        (2 * Math.floor(i / w)) / (h - 1) - 1,
      ),
      level: tone[i],
    };
  });
}

function sharedPigmentSurface(groups: Pigment[], width: number) {
  let state = 417,
    best = -Infinity,
    chosen: number[] = [];
  for (let iteration = 0; iteration < 128; iteration++) {
    const order = Array.from({ length: groups.length }, (_, i) => i);
    const count = Math.min(4 + (iteration % 5), order.length);
    for (let j = 0; j < count; j++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const k = j + Math.floor((state / 4294967296) * (order.length - j));
      [order[j], order[k]] = [order[k], order[j]];
    }
    const coef = surface(order.slice(0, count).map((i) => groups[i]));
    const errors = groups.map((g) => groupError(g, coef));
    const score =
      errors.reduce((s, e) => s + Math.max(0, 1 - (e / 8.5) ** 2), 0) /
        groups.length -
      0.000032 * Math.hypot(...coef.slice(1));
    if (score > best) {
      best = score;
      chosen = coef;
    }
  }
  let inliers = groups.filter((g) => groupError(g, chosen) < 9);
  if (inliers.length < Math.max(5, 0.54 * groups.length)) return;
  const centers = inliers.map((g) => g.center);
  if (Math.max(...centers) - Math.min(...centers) < 0.48 * width) return;
  const shades = inliers
    .flatMap((group) => group.samples.map((sample) => at(chosen, sample.basis)))
    .sort((a, b) => a - b);
  const tightAgreement =
    inliers.length >= 8 &&
    inliers.filter((g) => groupError(g, chosen) < 2).length >=
      0.8 * groups.length;
  if (
    shades[Math.floor(0.9 * (shades.length - 1))] -
      shades[Math.floor(0.1 * shades.length)] <
    (tightAgreement ? 8 : 15)
  )
    return;
  for (let j = 0; j < 2; j++) {
    chosen = surface(inliers);
    inliers = groups.filter((g) => groupError(g, chosen) < 10);
    if (inliers.length < 5) return;
  }
  return chosen;
}

function applyPigmentSurface(
  groups: Pigment[],
  coef: number[],
  tone: Uint8Array,
  w: number,
  h: number,
) {
  const result = new Uint8Array(tone.length);
  const error = surfaceResiduals(coef, tone, w, h);
  for (const { points } of groups) {
    const agreeing = points.filter((i) => error[i] < 18);
    const selected =
      agreeing.length > 0.66 * points.length
        ? points
        : agreeing.filter((i) => error[i] < 13);
    if (selected.length >= 28) for (const p of selected) result[p] = 1;
  }
  if (result.reduce((s, v) => s + v, 0) < Math.min(6000, 0.045 * w * h)) return;
  extendAcrossDarkArtwork(result, error, tone, w, h);
  const distance = distanceToMask(result, w, h);
  for (let i = 0; i < result.length; i++)
    if (distance[i] <= 2.3 && error[i] < 27) result[i] = 1;
  return result;
}

function surfaceResiduals(c: number[], tone: Uint8Array, w: number, h: number) {
  const residuals = new Float32Array(tone.length);
  for (let row = 0; row < h; row++) {
    const y = (2 * row) / (h - 1) - 1;
    const a = c[0] + y * (c[2] + y * (c[5] + y * c[9]));
    const b = c[1] + y * (c[4] + y * c[8]),
      d = c[3] + y * c[7];
    for (let col = 0; col < w; col++) {
      const x = (2 * col) / (w - 1) - 1,
        i = row * w + col;
      residuals[i] = Math.abs(tone[i] - (a + x * (b + x * (d + x * c[6]))));
    }
  }
  return residuals;
}

/** A dark printed character can become lighter than the drawing beneath
 * it. Check its observed physical edge before accepting the colour match. */
function extendAcrossDarkArtwork(
  result: Uint8Array,
  error: Float32Array,
  tone: Uint8Array,
  w: number,
  h: number,
) {
  const matched = new Uint8Array(tone.length);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (error[i] < 12 && neighborhoodRange(tone, w, i) < 27) matched[i] = 1;
    }
  for (const { rect, data, area } of maskComponents(matched, w, h, 18)) {
    if (area > 0.24 * w * h || touchesEdge(rect, w, h)) continue;
    const points = positions(rect, data, w);
    if (points.filter((i) => error[i] < 5).length < 0.7 * area) continue;
    if (hasPigmentBoundary(points, matched, tone, w, h))
      for (const i of points) result[i] = 1;
  }
}

function touchesEdge(rect: PixelRect, w: number, h: number) {
  return (
    rect.x <= 1 ||
    rect.y <= 1 ||
    rect.x + rect.w >= w - 1 ||
    rect.y + rect.h >= h - 1
  );
}

function hasPigmentBoundary(
  points: number[],
  matched: Uint8Array,
  tone: Uint8Array,
  w: number,
  h: number,
) {
  let visible = 0,
    perimeter = 0;
  for (const i of points) {
    const x = i % w,
      y = Math.floor(i / w);
    if (x < 4 || y < 4 || x + 4 >= w || y + 4 >= h) continue;
    for (const step of [1, -1, w, -w]) {
      if (matched[i + step]) continue;
      perimeter++;
      visible += Number(
        Math.max(
          Math.abs(tone[i + 3 * step] - tone[i]),
          Math.abs(tone[i + 4 * step] - tone[i]),
        ) > 31,
      );
    }
  }
  return perimeter >= 8 && visible > 0.51 * perimeter;
}

export function knockoutRings(
  tone: Float32Array,
  distance: Float32Array,
  stride: number,
  box: PixelRect,
) {
  const rings = Array.from({ length: 13 }, (): number[] => []);
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = y * stride + x,
        r = Math.round(distance[i]);
      if (r > 0 && r < rings.length) rings[r].push(tone[i]);
    }
  return rings;
}

export function knockoutWidth(rings: number[][]) {
  const levels = rings.slice(1).map((values) => {
    if (values.length < 5) return NaN;
    values.sort((a, b) => a - b);
    return values[Math.floor(0.5 * (values.length - 1))];
  });
  if (!levels.every(Number.isFinite)) return;
  const far = levels.slice(8, 12).sort((a, b) => a - b),
    base = (far[1] + far[2]) / 2;
  if (base < 150 || base > 246 || far[3] - far[0] > 11) return;
  const shoulder = levels.slice(0, 3).sort((a, b) => b - a);
  if (
    shoulder[1] < base + Math.max(4, 0.42 * (255 - base)) ||
    shoulder[0] < Math.max(242, base + 8)
  )
    return;
  const cutoff = base + 0.23 * (255 - base);
  const end = levels.findIndex(
    (v, i) => i >= 2 && v <= cutoff && levels[i + 1] <= cutoff + 3,
  );
  if (end >= 2 && end <= 8) return end + 1;
}
