import { maskComponents } from "./rasterMasks";
import type { PixelRect } from "./maskGeometry";
import { maskBoundsInRect } from "./imageRaster";

type Plate = {
  original: Buffer;
  width: number;
  height: number;
  stencil: Uint8Array;
};
type Line = { y: number; slope: number };
function luminance(p: Buffer, at: number) {
  return (p[at] + 2 * p[at + 1] + p[at + 2]) / 4;
}
function pigmentRuns(p: Plate, b: PixelRect) {
  let ink = 0,
    red = 0,
    lower = 0;
  for (let y = 0; y < b.h; y += 2)
    for (let x = 0; x < b.w; x += 2) {
      const i = (y + b.y) * p.width + b.x + x;
      if (!p.stencil[i]) continue;
      const at = 4 * i,
        g = p.original[at + 1],
        r = p.original[at + 2];
      ink++;
      if (y < b.h * 0.55 && r - g > 48 && r - p.original[at] > 35) red++;
      if (y > b.h * 0.44 && Math.max(p.original[at], g, r) < 145) lower++;
    }
  return red > 0.09 * ink && lower > 0.065 * ink;
}
function median(values: number[]) {
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}
function bank(p: Plate, y: number, x0: number, x1: number) {
  const channels: number[][] = [[], [], []];
  for (let x = x0; x < x1; x++)
    channels.forEach((c, k) => c.push(p.original[4 * (y * p.width + x) + k]));
  return channels.map(median);
}
function withinBanks(p: Plate, b: PixelRect, lo: number, hi: number) {
  return (
    hi - lo >= 7 &&
    b.x + b.w + 25 < p.width &&
    b.y >= 4 &&
    b.y + b.h + 4 < p.height
  );
}
function registration(p: Plate, b: PixelRect) {
  const lo = Math.max(0, b.x - Math.round(0.3 * b.w)),
    hi = b.x - Math.round(0.115 * b.w);
  const rhs = b.x + b.w;
  if (!withinBanks(p, b, lo, hi)) return;
  let rows = 0,
    flat = 0;
  const stock: number[] = [];
  for (let y = b.y + Math.round(0.46 * b.h); y < b.y + 0.91 * b.h; y += 5) {
    const c = bank(p, y, lo, hi),
      c1 = bank(p, y, lo, (lo + hi) >> 1),
      c2 = bank(p, y, (lo + hi) >> 1, hi);
    if (Math.min(...c) > 190 && c1.every((v, k) => Math.abs(v - c2[k]) <= 9))
      flat++;
    rows++;
    stock.push(c[1]);
  }
  const target = median(stock);
  if (
    flat < 0.86 * rows ||
    stock[Math.floor(stock.length * 0.84)] -
      stock[Math.floor(stock.length * 0.16)] >
      12
  )
    return;
  for (
    let x = rhs - Math.round(0.28 * b.w);
    x < Math.min(p.width - 22, rhs + Math.round(0.24 * b.w));
    x++
  ) {
    const levels: number[] = [];
    for (let y = b.y + Math.round(0.46 * b.h); y < b.y + 0.91 * b.h; y += 3)
      levels.push(p.original[4 * (y * p.width + x) + 1]);
    if (median(levels) < target - 44) return { lo, hi, border: x };
  }
}
function anchor(p: Plate, x: number, y: number) {
  if (y < 1 || y >= p.height - 1 || x < 0 || x >= p.width) return false;
  const at = 4 * (y * p.width + x),
    s = 4 * p.width;
  return (
    Math.min(
      luminance(p.original, at - s),
      luminance(p.original, at),
      luminance(p.original, at + s),
    ) < 123
  );
}
function marginRule(p: Plate, b: PixelRect): Line | undefined {
  let best = 0.91,
    line: Line | undefined;
  const span = Math.min(23, Math.round(0.28 * b.w));
  for (let y = b.y + 10; y < b.y + b.h * 0.51; y++) {
    for (let step = -19; step <= 19; step++) {
      const slope = step * 0.02;
      let left = 0,
        right = 0;
      for (let k = 3; k < span; k++) {
        const a = b.x - k,
          c = b.x + b.w + k;
        left += Number(anchor(p, a, Math.round(y - slope * k)));
        right += Number(anchor(p, c, Math.round(y + slope * (b.w + k))));
      }
      const score =
        (Math.min(left, right) + 0.005 * (left + right)) / (span - 3);
      if (score > best) {
        best = score;
        line = { y, slope };
      }
    }
  }
  return line;
}

/** Two-colour vertical type outside a panel. Require its exposed paper stock,
 * opposite frame and an oblique rule to agree before editing the margin. */
export function marginCaptionPlate(p: Plate) {
  const b = maskBoundsInRect(p.stencil, p.width, {
    x: 0,
    y: 0,
    w: p.width,
    h: p.height,
  });
  if (
    !b ||
    b.h < 180 ||
    b.h < 4.3 * b.w ||
    b.w < 24 ||
    b.w > 155 ||
    b.x < 0.3 * b.w ||
    !pigmentRuns(p, b)
  )
    return;
  const reference = registration(p, b);
  if (!reference) return;
  const rule = marginRule(p, b);
  if (!rule) return;
  return (pixels: Buffer) => {
    const { border, lo, hi } = reference;
    restoreUpperPaper(p, b, rule, pixels);
    for (let y = b.y; y < Math.min(p.height, b.y + b.h + 5); y++) {
      const c = bank(p, y, lo, hi);
      if (Math.min(...c) < 182) continue;
      const opposite = bank(p, y, border + 12, border + 22);
      const tip = opposite.every((v, k) => Math.abs(v - c[k]) < 18)
        ? b.x + b.w
        : border;
      restorePaperRow(p, b.x, rule, pixels, y, hi, tip, c);
    }
    return pixels;
  };
}

function restorePaperRow(
  p: Plate,
  left: number,
  rule: Line,
  pixels: Buffer,
  y: number,
  hi: number,
  tip: number,
  c: number[],
) {
  for (let x = hi; x < tip; x++) {
    if (y <= rule.y + rule.slope * (x - left) + 2) continue;
    const at = 4 * (y * p.width + x);
    const weight = Math.min(1, (x - hi) / 8, (tip - x) / 2);
    for (let k = 0; k < 3; k++)
      pixels[at + k] = Math.round(
        pixels[at + k] + weight * (c[k] - pixels[at + k]),
      );
  }
}

function restoreUpperPaper(p: Plate, b: PixelRect, rule: Line, pixels: Buffer) {
  const h = Math.min(
    p.height - b.y - 3,
    Math.ceil(rule.y - b.y + Math.abs(rule.slope) * b.w),
  );
  const local = new Uint8Array(b.w * h);
  for (let i = 0; i < local.length; i++) {
    const x = i % b.w,
      y = Math.floor(i / b.w),
      at = 4 * ((y + b.y) * p.width + x + b.x);
    if (y + b.y < rule.y + rule.slope * x - 4)
      local[i] = Number(luminance(pixels, at) < 247);
  }
  for (const part of maskComponents(local, b.w, h, 4)) {
    const r = part.rect;
    if (
      part.area > 180 ||
      r.w > 24 ||
      r.h > 24 ||
      Math.min(r.x, r.y, b.w - r.x - r.w, h - r.y - r.h) < 4
    )
      continue;
    const area = { ...r, x: b.x + r.x, y: b.y + r.y };
    const c = whiteSurround(p, pixels, area);
    if (!c) continue;
    fillResidue(p, pixels, area, c);
  }
}
function fillResidue(p: Plate, pixels: Buffer, area: PixelRect, c: number[]) {
  for (let y = area.y - 1; y <= area.y + area.h; y++)
    for (let x = area.x - 1; x <= area.x + area.w; x++) {
      const i = y * p.width + x;
      if (p.stencil[i]) pixels.set(c, i * 4);
    }
}
function whiteSurround(p: Plate, out: Buffer, r: PixelRect) {
  const channels: number[][] = [[], [], []];
  let tint = 0;
  for (let i = 0; i < (r.h + 6) * (r.w + 6); i++) {
    const y = r.y - 3 + Math.floor(i / (r.w + 6)),
      x = r.x - 3 + (i % (r.w + 6));
    const at = 4 * (y * p.width + x);
    if (x >= r.x - 1 && x <= r.x + r.w && y >= r.y - 1 && y <= r.y + r.h) {
      if (luminance(out, at) < 180) return;
      if (p.original[at + 2] - p.original[at + 1] > 25) tint++;
      continue;
    }
    channels.forEach((c, k) => c.push(out[at + k]));
  }
  if (tint < 0.1 * r.w * r.h) return;
  const colour = channels.map(median);
  if (colour.every((v) => v >= 249)) return colour;
}
