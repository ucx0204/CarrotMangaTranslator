import { printMaskGrid } from "./qwenPrintedPigment";
import { ruledBrushKeyline, thinOutlinedImpact } from "./qwenStockCrossing";
import {
  retainIndependentBrushPen,
  type BrushField as Field,
  type BrushFace,
  broadSoundKeyline,
  retainTerminalPanelRule,
  traceDryBrushEnds,
} from "./qwenSoundRim";
import type { maskComponents } from "./rasterMasks";

type Stroke = ReturnType<typeof maskComponents>[number];
type Samples = BrushFace & {
  near: number;
  axis: number;
  aspect: number;
  x: number;
  y: number;
};

function sampleStroke(
  field: Field,
  part: Stroke,
  distance: Float32Array,
  width: Float32Array,
): Samples {
  const { rect, data, area } = part;
  const positions: number[] = [];
  let dark = 0,
    overlap = 0,
    near = 0,
    thick = 0,
    sx = 0,
    sy = 0,
    xx = 0,
    yy = 0,
    xy = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const x = (i % rect.w) + rect.x,
      y = Math.floor(i / rect.w) + rect.y;
    const p = y * field.width + x;
    positions.push(p);
    dark += Number(field.tone[p] < 51);
    overlap += Number(distance[p] === 0);
    near += Number(distance[p] <= 17.5);
    thick = Math.max(thick, width[p]);
    sx += x;
    sy += y;
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  const x = sx / area,
    y = sy / area;
  const a = xx / area - x * x,
    b = yy / area - y * y,
    c = xy / area - x * y;
  const delta = Math.hypot(a - b, 2 * c);
  return {
    part,
    positions,
    dark: dark / area,
    overlap: overlap / area,
    near: near / area,
    thick,
    axis: Math.atan2(2 * c, a - b) / 2,
    aspect: Math.sqrt(
      Math.max(1, a + b + delta) / Math.max(0.3, a + b - delta),
    ),
    x,
    y,
  };
}

function paperRings({ part }: Samples, field: Field) {
  const { rect, data } = part,
    w = rect.w + 16,
    h = rect.h + 16;
  const local = new Uint8Array(w * h);
  for (let y = 0; y < rect.h; y++)
    local.set(data.subarray(y * rect.w, (y + 1) * rect.w), (y + 8) * w + 8);
  const dist = printMaskGrid(w, h).distance(local);
  const count = [0, 0],
    white = [0, 0];
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] === 0 || dist[i] > 7.3) continue;
    const x = (i % w) + rect.x - 8,
      y = Math.floor(i / w) + rect.y - 8;
    if (x < 0 || x >= field.width || y < 0 || y >= field.height) continue;
    const ring = Number(dist[i] > 3.4);
    count[ring]++;
    white[ring] += Number(field.tone[y * field.width + x] > 218);
  }
  return white.map((v, i) => v / Math.max(1, count[i]));
}

function brushBody(s: Samples, field: Field) {
  if (s.overlap < 0.48 || s.near < 0.9) return false;
  const [white, outer] = paperRings(s, field);
  return (
    contrastOnPaper(s, white, outer) ||
    (s.overlap > 0.9 && denseOwnedInk(s, white, outer))
  );
}
function contrastOnPaper(s: Samples, white: number, outer: number) {
  if (
    white > 0.72 &&
    s.dark > 0.68 &&
    (s.aspect > 2.65 ||
      (s.part.area >= 180 && white - outer > 0.035 && s.thick >= 2.4))
  )
    return true;
  return s.aspect > 4 && white > 0.52 && s.dark > 0.48 && white - outer > 0.035;
}
function denseOwnedInk(s: Samples, white: number, outer: number) {
  return (
    (s.aspect > 2.85 &&
      s.dark > 0.54 &&
      Math.max(white, outer) > 0.58 &&
      s.thick > 1.4) ||
    (s.part.area > 95 && s.thick > 3 && s.dark > 0.77 && outer > 0.55) ||
    isBroadBrushBody(s, outer)
  );
}

function isBroadBrushBody(s: Samples, outer: number) {
  return s.part.area > 1000 && s.thick > 4.6 && s.dark > 0.66 && outer > 0.66;
}

/** A detector sometimes selects an entire separate costume panel. One thin
 * dark edge inside an otherwise solid selection cannot establish lettering. */
function removeIsolatedTrim(field: Field, core: Uint8Array) {
  const grid = printMaskGrid(field.width, field.height);
  const dist = grid.distance(core);
  const discarded = new Uint8Array(core.length);
  for (const island of grid.components(field.owned, 1200)) {
    let explained = 0;
    const indices: number[] = [];
    island.data.forEach((on, i) => {
      if (!on) return;
      const p =
        (island.rect.y + Math.floor(i / island.rect.w)) * field.width +
        island.rect.x +
        (i % island.rect.w);
      indices.push(p);
      explained += Number(dist[p] <= 6.5);
    });
    if (explained < 0.32 * island.area)
      for (const p of indices) discarded[p] = 1;
  }
  return grid.distance(discarded);
}

function anchoredCompanion(
  s: Samples,
  coreDistance: Float32Array,
  field: Field,
) {
  if (s.part.area < 19 || s.dark < 0.48 || s.near < 0.88 || s.aspect < 5.5)
    return false;
  let near = 0,
    nearest = Infinity;
  for (const i of s.positions) {
    near += Number(coreDistance[i] <= 31);
    nearest = Math.min(nearest, coreDistance[i]);
  }
  if (nearest > 19 || near < 0.6 * s.part.area) return false;
  const [white, outer] = paperRings(s, field);
  return white > 0.58 && outer > 0.62;
}

/** A dry brush can disintegrate into small dots at its tip. Extend it only
 * when its direction points back through sustained selected native ink. */
function belongsToDryTip(s: Samples, field: Field, coreDistance: Float32Array) {
  if (s.part.area < 19 || s.aspect < 2.5 || s.dark < 0.49 || s.thick < 1.35)
    return false;
  const dx = Math.cos(s.axis),
    dy = Math.sin(s.axis);
  const [white, outer] = paperRings(s, field);
  if (Math.max(white, outer) < 0.57) return false;
  function onRay(sign: number) {
    let run = 0;
    for (let t = 1; t <= 84; t++) {
      const x = Math.round(s.x + t * dx * sign),
        y = Math.round(s.y + t * dy * sign);
      if (x < 0 || x >= field.width || y < 0 || y >= field.height) break;
      const p = y * field.width + x;
      run = coreDistance[p] < 3 ? run + 1 : 0;
      if (run >= 23) return true;
    }
    return false;
  }
  return onRay(1) || onRay(-1);
}

function mark(strokes: Samples[], data: Uint8Array) {
  for (const s of strokes) for (const p of s.positions) data[p] = 1;
}

function parallelPair(s: Samples, t: Samples) {
  return (
    s !== t &&
    Math.hypot(s.x - t.x, s.y - t.y) < 35 &&
    Math.abs(Math.cos(s.axis - t.axis)) > 0.96
  );
}

function tracedTip(
  s: Samples,
  candidates: Samples[],
  field: Field,
  core: Uint8Array,
) {
  const dx = Math.cos(s.axis),
    dy = Math.sin(s.axis);
  const continuation = candidates.filter((t) => {
    const x = t.x - s.x,
      y = t.y - s.y,
      along = Math.abs(x * dx + y * dy);
    return (
      t.overlap === 0 &&
      t.part.area >= 15 &&
      t.part.area < 0.62 * s.part.area &&
      t.aspect > 2 &&
      t.dark > 0.47 &&
      along > 8 &&
      along < 53 &&
      Math.abs(x * dy - y * dx) < 3.4 &&
      Math.abs(Math.cos(t.axis - s.axis)) > 0.95
    );
  });
  for (const t of continuation) extendTaper(s, t, field, core);
}
function extendTaper(s: Samples, t: Samples, field: Field, core: Uint8Array) {
  const length = Math.hypot(t.x - s.x, t.y - s.y),
    vx = (t.x - s.x) / length,
    vy = (t.y - s.y) / length;
  for (const p of t.positions) core[p] = 1;
  let gap = 0;
  for (let j = 1; j <= 57 && gap <= 7; j++) {
    const found = markTipSlice(field, core, t.x + j * vx, t.y + j * vy, vx, vy);
    gap = found ? 0 : gap + 1;
  }
}
function markTipSlice(
  field: Field,
  core: Uint8Array,
  cx: number,
  cy: number,
  vx: number,
  vy: number,
) {
  let found = false;
  const nx = Math.round(6 * vy),
    ny = Math.round(6 * vx);
  for (let off = -4; off <= 4; off++) {
    const x = Math.round(cx - off * vy),
      y = Math.round(cy + off * vx);
    if (x < 6 || y < 6 || x >= field.width - 6 || y >= field.height - 6)
      continue;
    const p = y * field.width + x;
    const flank = (offset: number) =>
      field.tone[(y + offset * ny) * field.width + x - offset * nx];
    if (field.tone[p] < 181 && Math.min(flank(1), flank(-1)) > 181) {
      core[p] = 1;
      found = true;
    }
  }
  return found;
}

export function measureNativeBrushInk(field: Field, broadOnly = false) {
  const { tone, owned, width: w, height: h } = field;
  const grid = printMaskGrid(w, h),
    nearby = grid.distance(owned);
  const dark = tone.map((v) => Number(v < 108)),
    width = grid.distance(dark.map((v) => 1 - v));
  const candidates = grid
    .components(dark, 8)
    .filter((s) => s.rect.w * s.rect.h < 0.55 * w * h)
    .map((s) => sampleStroke(field, s, nearby, width))
    .filter((s) => s.positions.some((p) => nearby[p] <= 75));
  return (
    thinOutlinedImpact(field, candidates) ||
    (!broadOnly && ruledBrushKeyline(field)) ||
    (!broadOnly && groupedBrushInk(field, candidates)) ||
    broadSoundKeyline(field, candidates)
  );
}

function groupedBrushInk(field: Field, candidates: Samples[]) {
  const { tone, width: w, height: h } = field;
  const grid = printMaskGrid(w, h);
  const bodies = candidates.filter((s) => brushBody(s, field));
  if (bodies.filter((s) => s.part.area >= 175).length < 3) return;
  const core = new Uint8Array(tone.length);
  mark(bodies, core);
  const trim = removeIsolatedTrim(field, core);
  const keep = bodies.filter((s) => s.positions.every((p) => trim[p] > 4));
  if (keep.filter((s) => s.part.area >= 175).length < 3) return;
  core.fill(0);
  mark(keep, core);
  const gap = grid.distance(core);
  includeAdjacentBrushStrokes(field, candidates, bodies, trim, gap, core);
  const long = keep.filter((s) => s.aspect > 3.15 && s.part.area >= 170);
  const heavy = keep.filter(
    (s) => s.part.area > 175 && s.thick >= 3 && s.dark > 0.81,
  );
  if (long.length < 3 && heavy.length < 3) return;
  if (long.length >= 6) for (const s of keep) traceDryBrushEnds(field, s, core);
  const extended = grid.distance(core);
  const span = Math.max(
    ...keep.map((s) => Math.max(s.part.rect.w, s.part.rect.h)),
  );
  const radius = Math.min(
    long.length >= 6 ? 17 : 12,
    Math.max(7.5, 0.07 * span),
  );
  const matte = Uint8Array.from(extended, (d, i) =>
    Number(d <= radius && trim[i] > 3),
  );
  retainTerminalPanelRule(field, core, matte, radius);
  // White pockets between adjacent prongs belong to the printed effect.
  // The sampler needs its narrow stencil, the final join needs those pockets.
  const outer = Uint8Array.from(grid.distance(matte), (v) => Number(v > 21));
  const closed = Uint8Array.from(grid.distance(outer), (v, i) =>
    Number(v > 18 || !!matte[i]),
  );
  const composite = Uint8Array.from(grid.distance(closed), (v, i) =>
    Number(v <= 10 && trim[i] > 3),
  );
  retainTerminalPanelRule(field, core, composite, radius);
  retainIndependentBrushPen(field, candidates, matte, composite, radius);
  return { matte, composite, measuredBrush: true as const };
}

function includeAdjacentBrushStrokes(
  field: Field,
  candidates: Samples[],
  bodies: Samples[],
  trim: Float32Array,
  gap: Float32Array,
  core: Uint8Array,
) {
  const adjacent = candidates.filter(
    (s) =>
      !bodies.includes(s) &&
      s.positions.every((p) => trim[p] > 7) &&
      s.positions.some((p) => gap[p] <= 38),
  );
  const companions = adjacent.filter(
    (s) => s.part.area <= 180 && anchoredCompanion(s, gap, field),
  );
  mark(
    adjacent.filter((s) => {
      if (
        s.overlap < 0.83 ||
        s.near < 0.98 ||
        s.part.area > 900 ||
        Math.max(s.part.rect.w, s.part.rect.h) > 56 ||
        !s.positions.some((p) => gap[p] <= 12)
      )
        return false;
      const [inner, outer] = paperRings(s, field);
      return denseOwnedInk(s, inner, outer);
    }),
    core,
  );
  mark(
    companions.filter((s) => companions.some((t) => parallelPair(s, t))),
    core,
  );
  const tips = adjacent.filter(
    (s) =>
      s.overlap === 0 &&
      s.part.area <= 240 &&
      s.aspect < 8 &&
      Math.max(s.part.rect.w, s.part.rect.h) < 53 &&
      belongsToDryTip(s, field, gap),
  );
  for (const tip of tips) tracedTip(tip, candidates, field, core);
  mark(tips, core);
  mark(
    adjacent.filter(
      (s) =>
        s.overlap > 0.72 &&
        s.aspect > 7 &&
        s.part.area >= 180 &&
        belongsToDryTip(s, field, gap),
    ),
    core,
  );
}
