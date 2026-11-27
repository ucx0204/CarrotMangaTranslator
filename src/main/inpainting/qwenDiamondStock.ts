import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { stockCrossingPen } from "./qwenStockCrossing";
import { maskComponents } from "./rasterMasks";

type Diamond = { x: number; y: number; radius: number; score: number };
type Backing = InpaintingWindowMask & { preservedPen?: Uint8Array };
type Field = {
  gray: Uint8Array;
  marked: Uint8Array;
  width: number;
  height: number;
};

/** A dark letter plate has four straight diagonal boundaries. Measure both
 * sides of each boundary so a run of dark screen dots cannot supply a rail. */
function edgeScore(field: Field, x: number, y: number, radius: number) {
  let score = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      let inside = 0,
        outside = 0;
      for (let i = 0; i < 13; i++) {
        const k = Math.round(radius * (0.19 + (0.62 * i) / 12));
        const index = (y + sy * k) * field.width + x + sx * (radius - k);
        inside += Number(field.gray[index - sx * 3] <= 58);
        outside += Number(field.gray[index + sx * 3] <= 58);
      }
      if (inside < 11 || inside - outside < 3) return 0;
      score += inside - outside + 0.1 * inside;
    }
  }
  return score / 52;
}

function locatePlates(field: Field, rect: PixelRect) {
  const candidates: Diamond[] = [];
  const mid = rect.y + rect.h / 2,
    dy = Math.min(20, rect.h * 0.26);
  for (let radius = 16; radius <= Math.min(128, rect.h * 1.55); radius += 2) {
    const left = Math.max(rect.x, radius + 4),
      right = Math.min(rect.x + rect.w, field.width - radius - 4);
    const top = Math.max(Math.floor(mid - dy), radius + 4),
      end = Math.min(mid + dy, field.height - radius - 4);
    for (let y = top; y <= end; y += 2)
      scanPlateRow(field, candidates, y, left, right, radius);
  }
  const plates: Diamond[] = [];
  for (const next of candidates.sort((a, b) => b.score - a.score)) {
    if (
      !plates.some(
        (p) =>
          Math.hypot(p.x - next.x, p.y - next.y) <
          0.72 * Math.max(p.radius, next.radius),
      )
    )
      plates.push(next);
  }
  return plates.sort((a, b) => a.x - b.x);
}

function scanPlateRow(
  field: Field,
  candidates: Diamond[],
  y: number,
  left: number,
  right: number,
  radius: number,
) {
  for (let x = left; x <= right; x += 2) {
    const score = edgeScore(field, x, y, radius);
    if (score > 0.72) candidates.push({ x, y, radius, score });
  }
}

function fitsSelection(plates: Diamond[], rect: PixelRect) {
  if (!plates.length || plates.length > 8) return false;
  const biggest = plates.reduce((a, b) => (a.radius > b.radius ? a : b));
  const first = plates[0],
    last = plates[plates.length - 1];
  return (
    (plates.length > 1 || biggest.radius >= 38) &&
    Math.max(...plates.map((p) => Math.abs(p.y - biggest.y))) <= 4 &&
    rect.y >= biggest.y - biggest.radius - 3 &&
    rect.y + rect.h <= biggest.y + biggest.radius + 3 &&
    rect.x >= first.x - first.radius - 8 &&
    rect.x + rect.w <= last.x + last.radius + 8 &&
    plates.every(
      (p, i) =>
        i === 0 ||
        p.x - plates[i - 1].x <= 1.18 * (p.radius + plates[i - 1].radius),
    )
  );
}

function interiorInk(
  field: Field,
  plate: Diamond,
  size: number,
  tone: Uint8Array,
  index: (i: number) => number,
) {
  const middle = size >> 1,
    r = plate.radius;
  const bright = tone.map((v) => Number(v > 34));
  const accepted = new Uint8Array(tone.length);
  for (const part of maskComponents(bright, size, size, 2)) {
    let central = 0,
      selected = 0,
      far = 0;
    const cells: number[] = [];
    part.data.forEach((on, i) => {
      if (!on) return;
      const x = part.rect.x + (i % part.rect.w),
        y = part.rect.y + Math.floor(i / part.rect.w);
      const dx = Math.abs(x - middle),
        dy = Math.abs(y - middle),
        j = y * size + x;
      cells.push(j);
      far = Math.max(far, dx + dy);
      central += Number(
        dx < 0.78 * r && dy < 0.72 * r && dx + dy < r - Math.max(3, 0.075 * r),
      );
      selected += Number(Boolean(field.marked[index(j)]));
    });
    if (
      far <= r + 1 &&
      central >= 0.86 * cells.length &&
      selected >= 0.12 * cells.length
    )
      for (const j of cells) accepted[j] = 1;
  }
  return { accepted, bright };
}

function samplePlate(
  field: Field,
  plate: Diamond,
  data: Uint8Array,
  levels: Uint8Array,
) {
  const { radius: r, x, y } = plate,
    pad = r + 3,
    size = pad * 2 + 1;
  const index = (i: number) =>
    (y - pad + Math.floor(i / size)) * field.width + x - pad + (i % size);
  const tone = Uint8Array.from(
    { length: size * size },
    (_, i) => field.gray[index(i)],
  );
  const rho = Uint16Array.from(
    tone,
    (_, i) => Math.abs((i % size) - pad) + Math.abs(Math.floor(i / size) - pad),
  );
  const rail = tone
    .filter((_, i) => rho[i] > 0.59 * r && rho[i] < 0.88 * r)
    .sort();
  const stock = rail[Math.floor(0.3 * rail.length)];
  if (stock > 24 || rail[Math.floor(0.58 * rail.length)] > stock + 16)
    return false;
  const { accepted, bright } = interiorInk(field, plate, size, tone, index);
  if (tone.filter((v, i) => v > 165 && Boolean(accepted[i])).length < 10)
    return false;
  const toInk = distanceToMask(accepted, size, size);
  const toArt = distanceToMask(
    bright.map((v, i) => Number(v && !accepted[i])),
    size,
    size,
  );
  const bank = tone
    .filter(
      (v, i) =>
        rho[i] < 0.87 * r && toInk[i] > 5 && toArt[i] > 3.5 && v <= stock + 12,
    )
    .sort();
  if (bank.length < 12) return false;
  for (let i = 0; i < tone.length; i++) {
    if (
      toInk[i] > 3.7 ||
      rho[i] >= r + 1 ||
      toArt[i] <= 1.5 ||
      toInk[i] >= toArt[i]
    )
      continue;
    const u = i % size,
      v = Math.floor(i / size),
      rank = (((37 * u + 73 * v + ((u * v) % 127)) % 257) + 0.5) / 257;
    const j = index(i);
    data[j] = 1;
    levels[j] = bank[Math.floor(rank * bank.length)];
  }
  return true;
}

export function measureDiamondCaption(
  bitmap: Buffer,
  stride: number,
  selected: PixelRect,
  instance: InpaintingWindowMask,
  bounds: PixelRect,
  includeBacking = false,
  measureEdges = false,
) {
  const rect = {
    ...selected,
    x: selected.x - bounds.x,
    y: selected.y - bounds.y,
  };
  const field = {
    gray: nativeLuminance(bitmap, stride, bounds),
    marked: projectWindowMask(instance, bounds),
    width: bounds.w,
    height: bounds.h,
  };
  const plates = locatePlates(field, rect);
  if (!fitsSelection(plates, rect)) return;
  const data = new Uint8Array(field.gray.length),
    levels = new Uint8Array(data.length);
  if (!plates.every((p) => samplePlate(field, p, data, levels))) return;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const j =
      4 *
      ((bounds.y + Math.floor(i / bounds.w)) * stride +
        bounds.x +
        (i % bounds.w));
    if (
      bitmap[j + 3] !== 255 ||
      Math.max(bitmap[j], bitmap[j + 1], bitmap[j + 2]) -
        Math.min(bitmap[j], bitmap[j + 1], bitmap[j + 2]) >
        6
    )
      return;
  }
  const stock = levels.filter((_, i) => Boolean(data[i])).sort();
  const backing = includeBacking
    ? diamondBacking(plates, bounds, measureEdges ? field : undefined)
    : undefined;
  return {
    bounds,
    data,
    levels,
    level: stock[stock.length >> 1],
    ...(backing ? { backing } : {}),
  };
}

function measuredRail(field: Field, plate: Diamond, sx: number, sy: number) {
  const spans: number[] = [];
  const { x, y, radius } = plate;
  for (let k = Math.ceil(0.16 * radius); k < 0.84 * radius; k++) {
    const i = (y + sy * k) * field.width + x + sx * (radius - k);
    const inner = field.gray[i - 5 * sx];
    const outer = field.gray[i + 6 * sx];
    if (inner > 49 || outer < inner + 44) continue;
    const halfway = (inner + outer) / 2;
    for (let step = -4; step <= 6; step++) {
      const brighter = field.gray[i + step * sx];
      if (brighter < halfway) continue;
      const darker = field.gray[i + (step - 1) * sx];
      spans.push(
        radius + step - (brighter - halfway) / Math.max(1, brighter - darker),
      );
      break;
    }
  }
  if (spans.length < Math.max(5, 0.17 * radius)) return radius;
  spans.sort((a, b) => a - b);
  if (
    spans[Math.floor(0.8 * spans.length)] -
      spans[Math.floor(0.2 * spans.length)] >
    2.5
  )
    return radius;
  return spans[spans.length >> 1];
}

function diamondBacking(plates: Diamond[], bounds: PixelRect, field?: Field) {
  if (plates.length < 2) return;

  // When the whole illustrated title is reconstructed, the lettering and
  // its printed diamonds must leave together, including their antialiasing.
  const data = new Uint8Array(bounds.w * bounds.h);
  const backing: Backing = {
    bounds,
    data,
    preservedPen: field && data.slice(),
  };
  const pen = field && stockCrossingPen(field.gray, bounds);
  for (const plate of plates) paintBackingPlate(plate, backing, field, pen);
  return backing;
}

function paintBackingPlate(
  plate: Diamond,
  backing: Backing,
  field?: Field,
  pen?: ReturnType<typeof stockCrossingPen>,
) {
  const { bounds } = backing;
  const { x, y, radius } = plate;
  const rails = [-1, 1].map((sy) =>
    [-1, 1].map((sx) =>
      field ? measuredRail(field, plate, sx, sy) : radius + 3,
    ),
  );
  const keyline = field ? 2.68 : 0;
  const reach = Math.ceil(Math.max(...rails.flat()) + Math.SQRT2 * keyline);
  for (
    let dy = Math.max(-reach, -y);
    dy <= Math.min(reach, bounds.h - 1 - y);
    dy++
  ) {
    for (
      let dx = Math.max(-reach, -x);
      dx <= Math.min(reach, bounds.w - 1 - x);
      dx++
    ) {
      // In diagonal coordinates a lozenge is a rectangle. The finite
      // distance at a tip keeps the white keyline clear of adjacent ink.
      const u = dx + dy,
        v = dx - dy;
      const a = Math.max(0, u - rails[1][1], -u - rails[0][0]);
      const b = Math.max(0, v - rails[0][1], -v - rails[1][0]);
      const distance2 = a * a + b * b;
      if (distance2 > 2 * keyline * keyline) continue;
      const index = (y + dy) * bounds.w + x + dx;
      const keepPen =
        distance2 > 2 * 0.85 ** 2 && pen?.(x + dx, y + dy, dx, dy);
      const layer = keepPen ? backing.preservedPen : backing.data;
      if (layer) layer[index] = 1;
    }
  }
}

export function groupedDiamondBacking(
  bitmap: Buffer,
  width: number,
  height: number,
  rect: PixelRect,
  mask: InpaintingWindowMask,
  measureEdges = false,
) {
  if (
    rect.h < 16 ||
    rect.h > 122 ||
    rect.w < 42 ||
    rect.w > 435 ||
    rect.w < 1.15 * rect.h
  )
    return;
  const bounds = expandRect(
    rect,
    width,
    height,
    Math.min(132, Math.ceil(1.55 * rect.h) + 5),
  );
  const stock = measureDiamondCaption(
    bitmap,
    width,
    rect,
    mask,
    bounds,
    true,
    measureEdges,
  );
  return stock?.backing;
}
