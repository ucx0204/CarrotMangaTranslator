import type { PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import type { maskComponents } from "./rasterMasks";
type Part = ReturnType<typeof maskComponents>[number];

export type BrushField = {
  tone: Uint8Array;
  owned: Uint8Array;
  width: number;
  height: number;
};
export type BrushFace = {
  part: Part;
  positions: number[];
  thick: number;
  dark: number;
  overlap: number;
};

function ownedBrushCoverage(field: BrushField, core: Uint8Array) {
  let total = 0,
    registered = 0;
  for (let i = 0; i < core.length; i++) {
    if (!field.owned[i] || field.tone[i] >= 108) continue;
    total++;
    registered += core[i];
  }
  return registered / Math.max(1, total);
}

/** Where the detector accounts for every heavy stroke, independently printed
 * fine pen can survive even between the prongs. Preserve its antialiasing in
 * both the model reference and the final composite. */
export function retainIndependentBrushPen(
  field: BrushField,
  faces: BrushFace[],
  matte: Uint8Array,
  composite: Uint8Array,
  radius: number,
) {
  const anchors = faces.filter(
    (f) => f.part.area >= 200 && f.thick >= 6.5 && f.overlap > 0.9,
  );
  if (anchors.length < 4) return;
  const core = new Uint8Array(matte.length);
  for (const f of anchors) for (const p of f.positions) core[p] = 1;
  if (ownedBrushCoverage(field, core) < 0.985) return;
  const pen = new Uint8Array(matte.length);
  const independent = faces.filter((f) => f.thick <= 5 && f.overlap <= 0.2);
  for (const f of independent) for (const p of f.positions) pen[p] = 1;
  const inkDistance = distanceToMask(core, field.width, field.height);
  const penDistance = distanceToMask(pen, field.width, field.height);
  for (let i = 0; i < matte.length; i++) {
    if (
      inkDistance[i] > radius + 2 ||
      (inkDistance[i] > 3 && penDistance[i] <= 3)
    )
      matte[i] = composite[i] = 0;
  }
}

/** A large solid sound can be a single connected character. Its printed
 * white keyline ends at the same distance along separate sides, even where
 * the underlying drawing is cut by the page edge. */
export function broadSoundKeyline(field: BrushField, candidates: BrushFace[]) {
  const faces = candidates.filter(
    (s) =>
      s.part.area >= 1800 && s.thick >= 7 && s.dark > 0.82 && s.overlap >= 0.86,
  );
  if (!faces.length || faces.length > 3) return;
  const core = new Uint8Array(field.owned.length);
  for (const face of faces) for (const i of face.positions) core[i] = 1;
  if (ownedBrushCoverage(field, core) < 0.82) return;
  const matte = new Uint8Array(core.length),
    composite = new Uint8Array(core.length);
  if (
    !faces.every((face) => addSolidFaceKeyline(field, face, matte, composite))
  )
    return;
  return { matte, composite, measuredBrush: "solid-impact" as const };
}

function addSolidFaceKeyline(
  field: BrushField,
  face: BrushFace,
  matte: Uint8Array,
  composite: Uint8Array,
) {
  const isolated = new Uint8Array(matte.length);
  for (const i of face.positions) isolated[i] = 1;
  const distance = distanceToMask(isolated, field.width, field.height);
  const radius = solidFaceKeyline(field, face.part.rect, distance);
  if (!radius) return false;
  for (let i = 0; i < matte.length; i++) {
    const d = distance[i];
    if (d > radius + 2 || (d > 1.6 && field.tone[i] < 211)) continue;
    if (d <= radius + 1) matte[i] = 1;
    composite[i] = 1;
  }
  return true;
}

function solidFaceKeyline(
  field: { tone: Uint8Array; width: number },
  bounds: PixelRect,
  distance: Float32Array,
) {
  const sum = Array.from({ length: 4 }, () => new Uint32Array(20));
  const paper = sum.map(() => new Uint32Array(20));
  const cx = bounds.x + bounds.w / 2,
    cy = bounds.y + bounds.h / 2;
  for (let i = 0; i < distance.length; i++) {
    const ring = Math.round(distance[i]);
    if (ring < 3 || ring >= 20) continue;
    const sector =
      Number(i % field.width >= cx) +
      2 * Number(Math.floor(i / field.width) >= cy);
    sum[sector][ring]++;
    paper[sector][ring] += Number(field.tone[i] >= 234);
  }
  const radii: number[] = [];
  for (let sector = 0; sector < 4; sector++) {
    const levels = Array.from(
      paper[sector],
      (v, i) => v / Math.max(1, sum[sector][i]),
    );
    if (sum[sector][4] < 18 || Math.min(...levels.slice(3, 6)) < 0.88) continue;
    const edge = levels.findIndex(
      (level, i) =>
        i >= 5 &&
        i <= 15 &&
        level < 0.85 &&
        Math.max(levels[i + 1], levels[i + 2]) < 0.77 &&
        levels[i - 2] - levels[i + 1] > 0.16,
    );
    if (edge >= 0) radii.push(edge);
  }
  if (radii.length >= 2 && Math.max(...radii) - Math.min(...radii) <= 2)
    return median(radii);
}

/** Follow tapering original ink beyond a native component. Dry ink can fall
 * above the binary threshold while still separating two white shoulders. */
export function traceDryBrushEnds(
  field: { tone: Uint8Array; width: number; height: number },
  stroke: {
    positions: number[];
    x: number;
    y: number;
    axis: number;
    aspect: number;
    part: Part;
  },
  core: Uint8Array,
) {
  if (
    stroke.aspect < 3.7 ||
    Math.max(stroke.part.rect.w, stroke.part.rect.h) < 28
  )
    return;
  const dx = Math.cos(stroke.axis),
    dy = Math.sin(stroke.axis);
  const projected = stroke.positions
    .map((p) => ({
      x: p % field.width,
      y: Math.floor(p / field.width),
      t:
        ((p % field.width) - stroke.x) * dx +
        (Math.floor(p / field.width) - stroke.y) * dy,
    }))
    .sort((a, b) => a.t - b.t);
  for (const sign of [-1, 1]) {
    const end = sign < 0 ? projected[0] : projected[projected.length - 1];
    const tail = projected.filter((p) => Math.abs(end.t - p.t) < 5);
    const x = tail.reduce((v, p) => v + p.x, 0) / tail.length,
      y = tail.reduce((v, p) => v + p.y, 0) / tail.length;
    traceTaperOnPaper(field, core, { x, y, dx: sign * dx, dy: sign * dy });
  }
}

function traceTaperOnPaper(
  field: { tone: Uint8Array; width: number; height: number },
  core: Uint8Array,
  ray: { x: number; y: number; dx: number; dy: number },
) {
  const { dx, dy } = ray,
    nx = -dy,
    ny = dx;
  let shift = 0,
    miss = 0;
  const samples: number[] = [];
  for (let step = 0; step <= 77 && miss <= 5; step++) {
    const cx = ray.x + step * dx + shift * nx,
      cy = ray.y + step * dy + shift * ny;
    const candidates: number[] = [];
    for (let j = -3; j <= 3; j++) {
      const x = Math.round(cx + j * nx),
        y = Math.round(cy + j * ny);
      if (Math.min(x, y, field.width - 1 - x, field.height - 1 - y) < 7)
        continue;
      const p = y * field.width + x,
        v = field.tone[p];
      const bank = (side: number) =>
        field.tone[
          Math.round(y + side * 6 * ny) * field.width +
            Math.round(x + side * 6 * nx)
        ];
      const shoulder = Math.min(bank(-1), bank(1));
      if (v < 200 && shoulder > 188 && shoulder - v > 36) {
        samples.push(p);
        candidates.push(j);
      }
    }
    if (!candidates.length) miss++;
    else {
      shift +=
        (0.27 * candidates.reduce((a, b) => a + b, 0)) / candidates.length;
      miss = 0;
    }
  }
  if (samples.length >= 12) for (const p of samples) core[p] = 1;
}
export type Evidence = { radius: number; exterior: number; interior: number };
export type Witness = { x: number; y: number; radii: number[] };

export function recordSoundRim(
  part: Part,
  sector: { x: number; y: number; readings: Evidence[] },
  paired: Witness[],
  independent: { part: Part; radius: number }[],
) {
  const radius = singleSoundRim(part, sector.readings);
  if (radius) independent.push({ part, radius });
  if (Math.max(part.rect.w, part.rect.h) > 63) return;
  const hard = measuredHardRim(sector.readings);
  if (hard) paired.push({ x: sector.x, y: sector.y, radii: hard });
}
/** A single large sound glyph can be isolated from the remaining syllables.
 * Require the same print width on all eight sides, measured against the
 * exposed original screen. Only extend this connected stroke. */
function singleSoundRim(part: Part, readings: Evidence[]) {
  if (
    part.area < 480 ||
    Math.max(part.rect.w, part.rect.h) < 40 ||
    readings.length !== 8
  )
    return;
  if (
    !readings.every(
      (q) => q.interior >= 0.95 && q.exterior < 0.32 && q.radius >= 3,
    )
  )
    return;
  const widths = readings.map((q) => q.radius);
  if (Math.max(...widths) - Math.min(...widths) <= 2)
    return median(widths) + 2.5;
}

function measuredHardRim(readings: Evidence[]) {
  const exposed = readings.filter((s) => s.exterior < 0.32);
  const clean = exposed.filter((s) => s.interior >= 0.94 && s.radius >= 3);
  const widths = clean.map((s) => s.radius);
  if (
    clean.length >= 1 &&
    clean.length >= 0.8 * exposed.length &&
    Math.max(...widths) - Math.min(...widths) <= 3
  )
    return widths;
}
export function matchingHardRims(rims: Witness[]) {
  if (
    rims.length < 3 ||
    !rims.some((rim) => rim.radii.length >= 5) ||
    rims.reduce((sum, rim) => sum + rim.radii.length, 0) < 10
  )
    return;
  const widths = rims.map((p) => median(p.radii));
  if (Math.max(...widths) - Math.min(...widths) <= 2) return rims;
}

export function median(v: number[]) {
  v.sort((a, b) => a - b);
  return (v[(v.length - 1) >> 1] + v[v.length >> 1]) / 2;
}

export function sharedBrushRadius(anchors: number, measurements: number[][]) {
  if (anchors < 4 || measurements.length < 3) return;
  const widths = measurements.map(median);
  const radius = median(widths);
  if (
    widths.filter((v) => Math.abs(v - radius) <= 3).length >=
    0.75 * widths.length
  )
    return radius;
}

export function brushPaper(
  part: Part,
  owned: Uint8Array,
  tone: Uint8Array,
  w: number,
  box: PixelRect,
  local: Uint8Array,
) {
  const at = (i: number) =>
    (box.y + Math.floor(i / box.w)) * w + box.x + (i % box.w);
  if (
    local.reduce((sum, on, i) => sum + Number(on && owned[at(i)]), 0) <
    0.26 * part.area
  )
    return;
  const distance = distanceToMask(local, box.w, box.h);
  let ring = 0,
    light = 0;
  distance.forEach((v, i) => {
    if (v < 2.5 || v >= 6.5) return;
    ring++;
    light += Number(tone[at(i)] >= 232);
  });
  if (!ring || light < 0.86 * ring) return;
  const widths: number[] = [];
  local.forEach((on, i) => {
    if (!on) return;
    const dx = distance[i + 2] - distance[i - 2],
      dy = distance[i + 2 * box.w] - distance[i - 2 * box.w];
    const norm = Math.hypot(dx, dy);
    if (norm < 1.15) return;
    const pos = at(i);
    const width = brushRay(
      tone,
      w,
      pos % w,
      Math.floor(pos / w),
      dx / norm,
      dy / norm,
    );
    if (width) widths.push(width);
  });
  return widths;
}

function brushRay(
  tone: Uint8Array,
  w: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
) {
  const sample = (r: number) => {
    const col = Math.round(x + dx * r),
      row = Math.round(y + dy * r);
    return col >= 0 && col < w ? tone[row * w + col] : undefined;
  };
  let paper = 0;
  for (let r = 2; r <= 17; r++) {
    const v = sample(r);
    if (v === undefined) return;
    if (v > 229) paper++;
    else if (r >= 5 && v <= 215 && paper >= 0.84 * (r - 2)) {
      const bank = [sample(r + 1), sample(r + 2), sample(r + 3)].filter(
        (q) => q !== undefined && q < 202,
      );
      if (bank.length >= 2) return r;
    }
  }
}

export function retainTerminalPanelRule(
  field: { tone: Uint8Array; width: number; height: number },
  core: Uint8Array,
  matte: Uint8Array,
  radius: number,
) {
  const { width, height } = field;
  let found = false;
  for (const vertical of [true, false]) {
    const counts = new Uint32Array(vertical ? width : height);
    const extent = vertical ? height : width;
    const coordinate = (p: number) =>
      vertical ? p % width : Math.floor(p / width);
    let first = counts.length,
      last = -1;
    field.tone.forEach((v, p) => {
      const c = coordinate(p);
      if (v < 75) counts[c]++;
      if (core[p]) {
        first = Math.min(first, c);
        last = Math.max(last, c);
      }
    });
    for (const sign of [-1, 1]) {
      const endpoint = sign < 0 ? first : last;
      const rule = firstRuleBeyondInk(counts, extent, endpoint, sign, radius);
      if (rule === undefined) continue;
      found = true;
      matte.forEach((_, p) => {
        if ((coordinate(p) - rule) * sign >= 0) matte[p] = 0;
      });
    }
  }
  return found;
}

function firstRuleBeyondInk(
  counts: Uint32Array,
  extent: number,
  endpoint: number,
  sign: number,
  radius: number,
) {
  for (let step = -2; step <= radius; step++) {
    const pos = endpoint + sign * step;
    if (counts[pos] >= 0.76 * extent && counts[pos + sign] >= 0.72 * extent)
      return pos;
  }
}
