import { smoothPrintTone } from "./qwenPrintTone";
import { knockoutRings } from "./qwenPrintedPigment";
import { fillEnclosedMaskHoles } from "../bubbleLayout/bubbleMaskComponents";
import { distanceFromMaskBoundary } from "../bubbleLayout/bubbleDistanceTransform";
import { mergeMaskIntoPage, pointInRect, type PixelRect } from "./maskGeometry";
import { maskComponents } from "./rasterMasks";

type Stroke = ReturnType<typeof maskComponents>[number];
type Field = {
  box: PixelRect;
  selected: PixelRect;
  gray: Uint8Array;
  distance: Float32Array;
};

/** A narrow upper stroke in upright type can receive a detector mask on one
 * end only. The entire original stroke must be surrounded by clean paper,
 * with another registered printed stroke directly underneath it. */
export function completePrintedCrossbars(
  dark: Uint8Array,
  field: Field,
  completed: Uint8Array,
) {
  const { selected, box } = field;
  if (selected.h < 320 || selected.h < 2.5 * selected.w) return;
  for (const part of maskComponents(dark, box.w, box.h, 65)) {
    if (
      partlySelectedCrossbar(part, field) &&
      printedBelowOnPaper(part.rect, field, dark)
    )
      mergeMaskIntoPage(completed, box.w, part.rect, part.data);
  }
}

function partlySelectedCrossbar(part: Stroke, { box, distance }: Field) {
  const { x, y, w, h } = part.rect;
  if (
    w < 22 ||
    w > 95 ||
    h < 2 ||
    h > 12 ||
    w < 4.1 * h ||
    part.area < 0.54 * w * h
  )
    return false;
  if (Math.min(x, y, box.w - x - w, box.h - y - h - w) < 7) return false;
  let touched = 0,
    near = 0;
  part.data.forEach((on, i) => {
    if (!on) return;
    const d = distance[(y + Math.floor(i / w)) * box.w + x + (i % w)];
    touched += Number(d === 0);
    near += Number(d <= 0.46 * w);
  });
  return (
    touched >= 0.08 * part.area &&
    touched <= 0.83 * part.area &&
    near === part.area
  );
}

function printedBelowOnPaper(
  { x, y, w, h }: PixelRect,
  { gray, box, distance }: Field,
  dark: Uint8Array,
) {
  let white = 0,
    bank = 0,
    lower = 0;
  for (let dy = -5; dy < h + 5; dy++)
    for (let dx = -5; dx < w + 5; dx++) {
      if (Math.min(dx + 2, w + 1 - dx, dy + 2, h + 1 - dy) >= 0) continue;
      white += Number(gray[(y + dy) * box.w + x + dx] > 237);
      bank++;
    }
  for (let dy = h + 3; dy < h + 0.68 * w; dy++)
    for (let dx = 0; dx < w; dx++) {
      const i = (y + dy) * box.w + x + dx;
      lower += Number(dark[i] && distance[i] <= 1);
    }
  return white >= 0.92 * bank && lower >= 0.8 * w;
}

export function isMaskContourPixel(mask: Uint8Array, width: number, i: number) {
  return (
    i % width === 0 ||
    i % width === width - 1 ||
    !mask[i - width] ||
    !mask[i + width] ||
    !mask[i - 1] ||
    !mask[i + 1]
  );
}

/** White-filled sound type has the same interior stock, printed pen level and
 * keyline width across its separate strokes, including a missed kana mark. */
export function completeHollowSoundMarks(field: Field) {
  const { box, selected, gray } = field;
  if (Math.min(selected.w, selected.h) < 55 || box.w * box.h > 580_000) return;
  const dark = gray.map((v) => Number(v < 112));
  const strokes = maskComponents(dark, box.w, box.h, 64)
    .filter(
      ({ rect: r }) =>
        Math.min(r.w, r.h) >= 9 &&
        Math.max(r.w, r.h) <= 180 &&
        Math.min(r.x, r.y, box.w - r.x - r.w, box.h - r.y - r.h) > 1,
    )
    .map((stroke) => printedStroke(stroke, field))
    .filter((p) => p !== undefined);
  const anchors = strokes.filter((p) => p.owned >= 0.91);
  if (anchors.length < 3) return;
  const matches = strokes.filter(
    (p) =>
      p.owned < 0.88 &&
      p.within >= 1 / 3 &&
      p.nearSelection >= 0.66 &&
      p.near <= Math.min(23, 0.29 * Math.max(p.rect.w, p.rect.h)) &&
      anchors.filter(
        (a) =>
          Math.abs(a.rim - p.rim) <= 0.38 &&
          Math.abs(a.pen - p.pen) <= 6 &&
          Math.abs(a.spread - p.spread) <= 4.5 &&
          Math.abs(a.paper - p.paper) <= 5,
      ).length >= 3,
  );
  if (
    !matches.length ||
    matches.length > 3 ||
    matches.filter((p) => p.owned < 0.1).length !== 1
  )
    return;
  const data = new Uint8Array(gray.length);
  for (const p of matches) mergeMaskIntoPage(data, box.w, p.rect, p.data);
  return { bounds: box, data };
}

function printedStroke(part: Stroke, { gray, distance, box, selected }: Field) {
  const r = part.rect;
  const filled = fillEnclosedMaskHoles(part.data, r.w, r.h);
  const area = filled.reduce((sum, v) => sum + v, 0);
  if (part.area > 0.52 * area || area > 0.73 * r.w * r.h) return;
  // A detector can clip the left or right shoulder of a slanted nib. Its
  // exposed ink and white core define the allowance in original pixels.
  const margin = Math.min(16, Math.ceil(area / Math.max(r.w, r.h)));
  const shoulder = {
    x: selected.x - margin,
    y: selected.y - margin,
    w: selected.w + 2 * margin,
    h: selected.h + 2 * margin,
  };
  const inside = distanceFromMaskBoundary(filled, r.w, r.h);
  let white = 0,
    paperSum = 0,
    samples = 0,
    rim = 0,
    penSum = 0,
    penSquares = 0;
  let owned = 0,
    within = 0,
    nearSelection = 0,
    near = Infinity;
  for (let i = 0; i < filled.length; i++) {
    if (!filled[i]) continue;
    const x = r.x + (i % r.w),
      y = r.y + Math.floor(i / r.w),
      index = y * box.w + x;
    const gx = box.x + x,
      gy = box.y + y,
      level = gray[index];
    if (pointInRect({ x: gx, y: gy }, selected)) within++;
    if (pointInRect({ x: gx, y: gy }, shoulder)) nearSelection++;
    near = Math.min(near, distance[index]);
    owned += Number(distance[index] <= 1.4);
    rim += Number(isMaskContourPixel(filled, r.w, i));
    if (part.data[i]) {
      penSum += level;
      penSquares += level * level;
    } else if (inside[i] >= 4.2) {
      white += Number(level > 229);
      paperSum += level;
      samples++;
    }
  }
  if (samples < 20 || white < 0.87 * samples) return;
  const pen = penSum / part.area,
    paper = paperSum / samples;
  return {
    rect: r,
    data: filled,
    near,
    owned: owned / area,
    within: within / area,
    nearSelection: nearSelection / area,
    rim: part.area / rim,
    pen,
    paper,
    spread: Math.sqrt(Math.max(0, penSquares / part.area - pen * pen)),
  };
}

export function measureLargeSoundInk(
  kind: "hollow" | "solid",
  gray: Uint8Array,
  bounds: PixelRect,
  local: PixelRect,
  letters: number,
) {
  const tone =
    kind === "solid"
      ? smoothPrintTone(Float32Array.from(gray), bounds, "fine-pen", 0.65)
      : gray;
  const binary = Uint8Array.from(tone, (v) =>
    Number(v < (kind === "solid" ? 192 : 148)),
  );
  const parts = maskComponents(binary, bounds.w, bounds.h, 62)
    .filter((p) => insideSelection(p.rect, local))
    .map((p) =>
      kind === "hollow" ? hollowPrint(p, gray, bounds.w) : solidPrint(p),
    )
    .filter((p): p is Stroke => Boolean(p));
  if (!coversSelection(parts, local, letters)) return;
  const mask = new Uint8Array(gray.length);
  for (const p of parts) mergeMaskIntoPage(mask, bounds.w, p.rect, p.data);
  return mask;
}

function insideSelection(part: PixelRect, box: PixelRect) {
  return (
    part.x >= box.x - 2 &&
    part.y >= box.y - 2 &&
    part.x + part.w <= box.x + box.w + 2 &&
    part.y + part.h <= box.y + box.h + 2
  );
}

function coversSelection(parts: Stroke[], box: PixelRect, letters: number) {
  if (parts.length < Math.max(4, letters) || parts.length > 4 * letters + 3)
    return false;
  const x = Math.min(...parts.map((p) => p.rect.x)),
    y = Math.min(...parts.map((p) => p.rect.y));
  const right = Math.max(...parts.map((p) => p.rect.x + p.rect.w));
  const bottom = Math.max(...parts.map((p) => p.rect.y + p.rect.h));
  return right - x > 0.79 * box.w && bottom - y > 0.81 * box.h;
}

function hollowPrint(part: Stroke, gray: Uint8Array, width: number) {
  const { w, h, x, y } = part.rect;
  if (Math.min(w, h) < 10 || Math.max(w, h) > 135) return;
  const filled = fillEnclosedMaskHoles(part.data, w, h);
  let area = 0,
    white = 0;
  for (let i = 0; i < filled.length; i++) {
    if (!filled[i]) continue;
    area++;
    if (gray[(y + Math.floor(i / w)) * width + x + (i % w)] > 228) white++;
  }
  const ink = part.area / area;
  if (ink >= 0.44 || ink < 0.12 || white < 0.53 * area || area < 140) return;
  return { ...part, area, data: filled };
}

function solidPrint(part: Stroke) {
  const { w, h } = part.rect;
  if (part.area < 220 || h < 32 || h < 1.45 * w) return;
  const depth = distanceFromMaskBoundary(part.data, w, h);
  // Screentone or a thin hair contour can be just as dark. Each candidate
  // needs a substantial ink interior, including at the end of the selection.
  let core = 0;
  for (const v of depth) if (v >= 3.5) core++;
  if (core < 0.13 * part.area) return;
  return part;
}

/** Small kana can have just two enclosed, white-filled pen strokes.
 * Both interiors must survive an independent cut through the antialiasing. */
export function isolatedHollowKana(
  gray: Uint8Array,
  bounds: PixelRect,
  selection: PixelRect,
) {
  const local = {
    ...selection,
    x: selection.x - bounds.x,
    y: selection.y - bounds.y,
  };
  const strokesAt = (level: number) =>
    maskComponents(
      gray.map((v) => Number(v < level)),
      bounds.w,
      bounds.h,
      16,
    ).filter(
      ({ rect }) =>
        insideSelection(rect, local) && Math.min(rect.w, rect.h) >= 5,
    );
  const lighter = strokesAt(159);
  const strokes = strokesAt(115)
    .map((p) => {
      const peer = lighter.find(
        (q) =>
          Math.abs(p.rect.x - q.rect.x) <= 1 &&
          Math.abs(p.rect.y - q.rect.y) <= 1 &&
          Math.abs(p.rect.w - q.rect.w) <= 2 &&
          Math.abs(p.rect.h - q.rect.h) <= 2 &&
          q.area >= p.area &&
          q.area <= 1.45 * p.area,
      );
      if (!peer) return;
      const { rect, data } = peer;
      const filled = fillEnclosedMaskHoles(data, rect.w, rect.h);
      let hole = 0,
        paper = 0;
      filled.forEach((on, i) => {
        if (!on || data[i]) return;
        hole++;
        const global =
          (rect.y + Math.floor(i / rect.w)) * bounds.w + rect.x + (i % rect.w);
        paper += Number(gray[global] >= 210);
      });
      if (hole >= 6 && paper > 0.53 * hole && hole >= 0.07 * peer.area)
        return { rect, data: filled, area: hole + peer.area };
    })
    .filter((p): p is Stroke => Boolean(p));
  if (strokes.length < 2 || strokes.length > 4) return;
  const left = Math.min(...strokes.map((p) => p.rect.x)),
    top = Math.min(...strokes.map((p) => p.rect.y));
  const right = Math.max(...strokes.map((p) => p.rect.x + p.rect.w)),
    bottom = Math.max(...strokes.map((p) => p.rect.y + p.rect.h));
  if (
    right - left < 0.48 * local.w ||
    bottom - top < 0.56 * local.h ||
    Math.abs((left + right) / 2 - local.x - local.w / 2) > 0.19 * local.w ||
    Math.abs((top + bottom) / 2 - local.y - local.h / 2) > 0.18 * local.h
  )
    return;
  const mask = new Uint8Array(gray.length);
  for (const p of strokes) mergeMaskIntoPage(mask, bounds.w, p.rect, p.data);
  return mask;
}

export function measuredSoundKeyline(
  gray: Uint8Array,
  distance: Float32Array,
  size: PixelRect,
) {
  const rings = knockoutRings(Float32Array.from(gray), distance, size.w, {
    ...size,
    x: 0,
    y: 0,
  });
  const low = rings.map(
    (ring) => ring.sort((a, b) => a - b)[Math.floor(0.09 * ring.length)] ?? NaN,
  );
  const shoulder = Math.min(low[2], low[3]);
  if (shoulder < 230) return;
  for (let i = 3; i <= 8; i++) {
    if (
      low[i] < shoulder - 31 &&
      low[i + 1] < shoulder - 39 &&
      low[i + 2] < shoulder - 39
    )
      return i + 0.6;
  }
}

/** Some sides of white-backed display ink extend a few pixels past the
 * common keyline. Follow the visible white band only where its outward
 * normal reaches darker artwork and its tangent stays on the same band. */
export function visibleSoundKeyline(
  gray: Uint8Array,
  box: PixelRect,
  mask: Uint8Array,
) {
  const { w, h } = box;
  const inside = distanceFromMaskBoundary(mask, w, h);
  const outside = distanceFromMaskBoundary(
    mask.map((v) => 1 - v),
    w,
    h,
  );
  const field = smoothPrintTone(
    outside.map((v, i) => v - inside[i]),
    box,
    "fine-pen",
    1.55,
  );
  const data = mask.slice();
  for (let y = 8; y < h - 8; y++) {
    for (let x = 8; x < w - 8; x++) {
      const i = y * w + x;
      if (!outside[i] || outside[i] > 3.85 || gray[i] <= 169) continue;
      const dx = field[i + 1] - field[i - 1];
      const dy = field[i + w] - field[i - w];
      const scale = Math.hypot(dx, dy);
      if (!scale) continue;
      const sample = (across: number, along: number) => {
        const sx = Math.round(x + (dx * across - dy * along) / scale);
        const sy = Math.round(y + (dy * across + dx * along) / scale);
        return gray[sy * w + sx];
      };
      if (whiteToPrintedStock(sample)) data[i] = 1;
    }
  }
  return { bounds: box, data };
}

function whiteToPrintedStock(
  sample: (across: number, along: number) => number,
) {
  const tangent = [-2, -1, 0, 1, 2];
  if (tangent.filter((t) => sample(0, t) > 203).length < 3) return false;
  const inner = [-1.25, -2.25, -3.25]
    .flatMap((d) => [-1, 0, 1].map((t) => sample(d, t)))
    .sort((a, b) => a - b);
  const mean = (v: number[]) =>
    v.reduce((sum, level) => sum + level, 0) / v.length;
  const white = mean(inner);
  if (inner[2] <= 218 || white <= 234) return false;
  const bank = [2.55, 3.7, 5, 6.5]
    .flatMap((d) => tangent.map((t) => sample(d, t)))
    .sort((a, b) => a - b);
  return (bank[9] + bank[10]) / 2 < 217 && white - mean(bank) > 34;
}
