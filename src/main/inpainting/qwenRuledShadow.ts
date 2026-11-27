import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import type { NativeImage } from "electron";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import { maskBoundsInRect } from "./imageRaster";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { maskComponents } from "./rasterMasks";

export function measuredRuledShadow(
  bitmap: Buffer,
  page: { width: number; height: number },
  lettering: InpaintingWindowMask,
) {
  const { bounds, data } = lettering,
    local = maskBoundsInRect(data, bounds.w, {
      x: 0,
      y: 0,
      w: bounds.w,
      h: bounds.h,
    });
  if (!isVerticalLettering(local)) return;
  const radius = Math.min(28, Math.max(11, Math.round(local.w * 0.46)));
  const view = expandRect(
    { ...local, x: local.x + bounds.x, y: local.y + bounds.y },
    page.width,
    page.height,
    radius * 2 + 6,
  );
  const stencil = projectWindowMask(lettering, view),
    distance = distanceToMask(stencil, view.w, view.h);
  const gray = new Uint8Array(stencil.length),
    band = new Uint8Array(stencil.length);
  const count = [0, 0, 0],
    light = [0, 0, 0],
    dark = [0, 0, 0];
  let tinted = 0;
  for (let i = 0; i < gray.length; i++) {
    const at =
        4 *
        ((view.y + Math.floor(i / view.w)) * page.width +
          view.x +
          (i % view.w)),
      v = bitmap[at + 1];
    gray[i] = v;
    const k = stencil[i] ? 0 : distance[i] < 0.34 * radius ? 1 : 2;
    if (k === 2 && (distance[i] < radius || distance[i] > 2 * radius)) continue;
    if (k === 2) band[i] = 1;
    count[k]++;
    light[k] += Number(v > 218);
    dark[k] += Number(v < 150);
    tinted += Number(
      Math.max(bitmap[at], v, bitmap[at + 2]) -
        Math.min(bitmap[at], v, bitmap[at + 2]) >
        10,
    );
  }
  if (
    !paperShadow(count, light, dark, tinted) ||
    !hasRuledPeriod(gray, band, view)
  )
    return;
  return {
    bounds: view,
    data: Uint8Array.from(distance, (x) => Number(x <= radius)),
  };
}

function isVerticalLettering(box: PixelRect | null): box is PixelRect {
  return (
    !!box &&
    box.w >= 12 &&
    box.w <= 150 &&
    box.h >= 1.25 * box.w &&
    box.h <= 275
  );
}

function paperShadow(
  n: number[],
  light: number[],
  dark: number[],
  tinted: number,
) {
  return (
    Math.min(...n) > 65 &&
    tinted < 0.012 * (n[0] + n[1] + n[2]) &&
    light[0] > 0.41 * n[0] &&
    dark[1] > 0.52 * n[1] &&
    light[1] < 0.19 * n[1] &&
    light[2] > 0.65 * n[2] &&
    dark[2] < 0.24 * n[2]
  );
}

function hasRuledPeriod(gray: Uint8Array, bank: Uint8Array, view: PixelRect) {
  const dx = new Int8Array(gray.length);
  let across = 0,
    along = 0;
  for (let i = 0; i < gray.length - view.w; i++) {
    dx[i] = Math.max(-75, Math.min(75, gray[i + 1] - gray[i]));
    if (bank[i]) {
      across += Math.abs(dx[i]);
      along += Math.abs(gray[i + view.w] - gray[i]);
    }
  }
  if (across < 1.55 * along) return false;
  for (let lag = 4; lag <= 14; lag++) {
    let cross = 0,
      energy = 0;
    for (let i = 0; i < dx.length - lag; i++) {
      if (!bank[i] || !bank[i + lag] || (i % view.w) + lag >= view.w) continue;
      cross += dx[i] * dx[i + lag];
      energy += dx[i] * dx[i] + dx[i + lag] * dx[i + lag];
    }
    if (energy > 16000 && 2 * cross > 0.36 * energy) return true;
  }
  return false;
}

export async function restoreNativePrintWindow(
  source: NativeImage,
  stencil: Uint8Array,
  restore: (image: NativeImage, mask: NativeImage) => Promise<NativeImage>,
  kind: "ruled-sound-shadow" | "balloon-edge-reading",
) {
  const { nativeImage } = await import("electron");
  const size = source.getSize(),
    box = maskBoundsInRect(stencil, size.width, {
      x: 0,
      y: 0,
      w: size.width,
      h: size.height,
    });
  if (!box) return source;
  const rect =
    kind === "balloon-edge-reading"
      ? nativeReadingView(box, size)
      : expandRect(
          box,
          size.width,
          size.height,
          Math.min(82, Math.ceil(0.55 * box.h)),
        );
  const view = source
    .crop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    .toBitmap();
  const ink = projectWindowMask(
    { bounds: { x: 0, y: 0, w: size.width, h: size.height }, data: stencil },
    rect,
  );
  if (kind === "ruled-sound-shadow")
    removeDetachedInkFromReference(view, ink, rect);
  const tileSize = Math.max(512, rect.w, rect.h),
    tile = Buffer.alloc(tileSize * tileSize * 4),
    mask = Buffer.alloc(tile.length, 255);
  for (let y = 0; y < tileSize; y++)
    for (let x = 0; x < tileSize; x++) {
      const pos = reflect(y, rect.h) * rect.w + reflect(x, rect.w),
        at = 4 * (y * tileSize + x);
      view.copy(tile, at, 4 * pos, 4 * pos + 4);
      mask.fill(ink[pos] ? 255 : 0, at, at + 3);
    }
  const grid = { width: tileSize, height: tileSize };
  const estimate = (
    await restore(
      nativeImage.createFromBitmap(tile, grid),
      nativeImage.createFromBitmap(mask, grid),
    )
  ).toBitmap();
  if (kind === "balloon-edge-reading")
    clearDetachedPrintResidue(estimate, tile, mask, tileSize);
  const result = source.toBitmap();
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue;
    const x = i % rect.w,
      y = Math.floor(i / rect.w),
      at = 4 * (y * tileSize + x);
    const target = 4 * ((rect.y + y) * size.width + rect.x + x);
    if (kind === "ruled-sound-shadow")
      result.fill(estimate[at + 1], target, target + 3);
    else estimate.copy(result, target, at, at + 3);
  }
  return nativeImage.createFromBitmap(result, size);
}

function reflect(x: number, length: number) {
  if (length < 2) return 0;
  const period = 2 * (length - 1),
    m = x % period;
  return Math.min(m, period - m);
}

function removeDetachedInkFromReference(
  image: Buffer,
  ink: Uint8Array,
  rect: PixelRect,
) {
  const dark = Uint8Array.from(ink, (_, i) => Number(image[4 * i + 1] < 175));
  const dist = distanceToMask(ink, rect.w, rect.h);
  for (const part of maskComponents(dark, rect.w, rect.h, 1)) {
    const r = part.rect;
    if (part.area > 95 || r.w > 13 || r.h > 18) continue;
    const indices: number[] = [];
    part.data.forEach((on, i) => {
      if (on)
        indices.push((r.y + Math.floor(i / r.w)) * rect.w + r.x + (i % r.w));
    });
    if (!indices.some((i) => dist[i] > 0 && dist[i] < 10)) continue;
    for (const i of indices) image.fill(255, 4 * i, 4 * i + 3);
  }
}

function nativeReadingView(
  box: PixelRect,
  size: { width: number; height: number },
) {
  const w = Math.min(512, size.width),
    h = Math.min(512, size.height);
  return {
    x: Math.max(
      0,
      Math.min(size.width - w, Math.floor(box.x + (box.w - w) / 2)),
    ),
    y: Math.max(
      0,
      Math.min(size.height - h, Math.floor(box.y + (box.h - h) / 2)),
    ),
    w,
    h,
  };
}

function clearDetachedPrintResidue(
  result: Buffer,
  original: Buffer,
  holes: Buffer,
  side: number,
) {
  const dark = Uint8Array.from({ length: side * side }, (_, i) =>
    Number(result[4 * i + 1] < 195),
  );
  for (const part of maskComponents(dark, side, side, 3)) {
    const r = part.rect;
    if (
      part.area > 95 ||
      r.w > 16 ||
      r.h > 20 ||
      Math.min(r.x, r.y, side - r.x - r.w, side - r.y - r.h) < 4
    )
      continue;
    let originalPaper = 0,
      owned = 0;
    part.data.forEach((on, i) => {
      if (!on) return;
      const at = 4 * ((r.y + Math.floor(i / r.w)) * side + r.x + (i % r.w));
      originalPaper += Number(original[at + 1] > 200);
      owned += Number(holes[at] > 0);
    });
    if (owned !== part.area || originalPaper < 0.57 * part.area) continue;
    const paper = lightPrintBank(result, side, r);
    if (!paper) continue;
    const halo = dilateBinaryMaskDisk(part.data, r.w, r.h, 2);
    halo.forEach((on, i) => {
      if (!on) return;
      const at = 4 * ((r.y + Math.floor(i / r.w)) * side + r.x + (i % r.w));
      if (holes[at] && result[at + 1] < paper[1]) result.set(paper, at);
    });
  }
}

function lightPrintBank(result: Buffer, side: number, r: PixelRect) {
  const bands: number[][] = [[], [], []];
  for (let y = r.y - 3; y < r.y + r.h + 3; y++)
    for (let x = r.x - 3; x < r.x + r.w + 3; x++) {
      if (x >= r.x - 1 && x <= r.x + r.w && y >= r.y - 1 && y <= r.y + r.h)
        continue;
      const at = 4 * (y * side + x);
      bands.forEach((b, k) => b.push(result[at + k]));
    }
  for (const b of bands) {
    b.sort((a, v) => a - v);
    if (
      b[Math.floor(b.length * 0.1)] < 216 ||
      b[Math.floor(b.length * 0.9)] - b[Math.floor(b.length * 0.1)] > 16
    )
      return;
  }
  return bands.map((b) => b[b.length >> 1]);
}
