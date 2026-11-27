import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import { maskBoundsInRect } from "./imageRaster";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { maskComponents } from "./rasterMasks";
import { measureVerticalCaptions } from "./qwenVerticalCaptionStock";
import { measureDiamondCaption } from "./qwenDiamondStock";
import {
  findCaptionBand,
  publisherRibbonBacking,
  verifyDecodedCaption,
} from "./qwenPrintedSubtitle";

type Part = ReturnType<typeof maskComponents>[number];
type Caption = InpaintingWindowMask & { level: number; levels?: Uint8Array };

function quantile(sorted: ArrayLike<number>, fraction: number) {
  return sorted[Math.round((sorted.length - 1) * fraction)];
}

/** Include the opaque stock of a subtitle selected with its entire cover title. */
export function measurePublisherRibbon(
  bitmap: Buffer,
  size: { width: number; height: number },
  rect: PixelRect,
) {
  if (rect.h < 7 || rect.h > 65 || rect.w < 9 * rect.h) return;
  const bounds = expandRect(
    rect,
    size.width,
    size.height,
    Math.ceil(3 * rect.h),
  );
  const local = { ...rect, x: rect.x - bounds.x, y: rect.y - bounds.y };
  const gray = nativeLuminance(bitmap, size.width, bounds);
  const band = findCaptionBand(gray, bounds.w, local);
  if (band) return publisherRibbonBacking(gray, bounds, local, band);
}

function measureStock(
  tone: Uint8Array,
  marked: Uint8Array,
  distance: Float32Array,
  w: number,
  rect: PixelRect,
) {
  const levels: number[] = [];
  let owned = 0,
    bright = 0;
  for (let k = 0; k < 8; k++) {
    const left = rect.x + Math.floor((rect.w * k) / 8),
      right = rect.x + Math.floor((rect.w * (k + 1)) / 8);
    const { known, light, selected } = sampleColumnStock(
      tone,
      marked,
      distance,
      w,
      left,
      right,
    );
    owned += selected;
    const area = ((right - left) * tone.length) / w;
    if (
      known.length < Math.max(12, 0.056 * area) ||
      light <= 0.026 * area ||
      light >= 0.51 * area
    )
      return;
    known.sort((a, b) => a - b);
    if (quantile(known, 0.9) > 22) return;
    levels.push(quantile(known, 0.5));
    bright += light;
  }
  levels.sort((a, b) => a - b);
  if (levels[7] - levels[0] <= 6 && owned >= 0.8 * bright)
    return quantile(levels, 0.5);
}

function sampleColumnStock(
  tone: Uint8Array,
  marked: Uint8Array,
  distance: Float32Array,
  w: number,
  left: number,
  right: number,
) {
  let selected = 0;
  const known: number[] = [];
  let light = 0;
  for (let y = 0; y < tone.length / w; y++)
    for (let x = left; x < right; x++) {
      const i = y * w + x;
      if (tone[i] > 90) {
        light++;
        selected += Number(Boolean(marked[i]));
      }
      if (distance[i] >= 2.45) known.push(tone[i]);
    }
  return { known, light, selected };
}

/** Independently spaced emblems between words can belong to the illustration
 * even when the detector includes them in the same instance as the letters. */
function isolatedEmblem(p: Part, glyphs: Part[], h: number) {
  const index = glyphs.indexOf(p);
  if (index < 1 || index >= glyphs.length - 1 || glyphs.length < 5)
    return false;
  const a = glyphs[index - 1].rect,
    b = glyphs[index + 1].rect,
    box = p.rect;
  return (
    box.x - a.x - a.w > 0.43 * h &&
    b.x - box.x - box.w > 0.43 * h &&
    box.y <= Math.min(a.y, b.y) - 2 &&
    box.y + box.h >= Math.max(a.y + a.h, b.y + b.h) &&
    p.area > 0.53 * box.w * box.h &&
    hasSolidInterior(p)
  );
}

function hasSolidInterior(part: Part) {
  const { w, h } = part.rect;
  const surround = new Uint8Array((w + 2) * (h + 2)).fill(1);
  part.data.forEach((on, i) => {
    if (on) surround[(1 + Math.floor(i / w)) * (w + 2) + 1 + (i % w)] = 0;
  });
  return distanceToMask(surround, w + 2, h + 2).some(
    (d) => d >= Math.max(4, 0.23 * w),
  );
}

function captionStrokes(
  ink: Uint8Array,
  marked: Uint8Array,
  w: number,
  rect: PixelRect,
) {
  const h = ink.length / w,
    parts = maskComponents(ink, w, h, 1);
  const selected: Part[] = [],
    dashes: Part[] = [];
  const glyphs = parts
    .filter(
      (p) =>
        p.rect.h >= 0.48 * rect.h &&
        p.area >= 12 &&
        p.rect.x >= rect.x - 3 &&
        p.rect.x + p.rect.w <= rect.x + rect.w + 3,
    )
    .sort((a, b) => a.rect.x - b.rect.x);
  const protectedInk = new Uint8Array(ink.length);
  for (const p of parts) {
    if (isolatedEmblem(p, glyphs, rect.h)) {
      mergeMaskIntoPage(protectedInk, w, p.rect, p.data);
      continue;
    }
    const kind = readCaptionStroke(p, marked, w, h, rect);
    if (kind === "conflict") return;
    if (kind === "letter") selected.push(p);
    if (kind === "dash") dashes.push(p);
  }
  const core = new Uint8Array(ink.length);
  for (const p of selected) mergeMaskIntoPage(core, w, p.rect, p.data);
  if (core.reduce((sum, v) => sum + v, 0) < 38) return;
  addPairedDashes(core, w, dashes, rect);
  const reach = distanceToMask(core, w, h),
    keep = distanceToMask(protectedInk, w, h);
  return marked.map((on, i) =>
    Number(keep[i] > 4.5 && (reach[i] <= 3.9 || (on && reach[i] <= 8))),
  );
}

function readCaptionStroke(
  p: Part,
  marked: Uint8Array,
  w: number,
  h: number,
  rect: PixelRect,
) {
  const { x, y, w: pw, h: ph } = p.rect;
  let count = 0;
  p.data.forEach((on, i) => {
    if (on && marked[(y + Math.floor(i / pw)) * w + x + (i % pw)]) count++;
  });
  const owned = count / p.area;
  const inset = Math.min(x - rect.x, rect.x + rect.w - x - pw);
  if (owned > 0.42 || (owned > 0.05 && p.area < 18 && inset >= -3)) {
    if (pw > Math.max(2.8 * rect.h, 0.125 * rect.w) || y === 0 || y + ph >= h)
      return "conflict";
    return "letter";
  } else if (isCaptionDash(p.rect, rect, h)) return "dash";
  else if (owned > 0.05 || (inset >= 0 && p.area > 5)) return "conflict";
  return "outside";
}

function isCaptionDash(part: PixelRect, rect: PixelRect, h: number) {
  const { x, y, w: pw, h: ph } = part;
  return (
    ph <= Math.max(3, 0.2 * rect.h) &&
    pw >= 0.26 * rect.h &&
    pw <= 1.2 * rect.h &&
    Math.abs(y + ph / 2 - h / 2) < 0.22 * rect.h &&
    x > rect.x - 1.2 * rect.h &&
    x < rect.x + rect.w + 1.2 * rect.h &&
    (x + pw <= rect.x + 2 || x >= rect.x + rect.w - 2)
  );
}

function addPairedDashes(
  core: Uint8Array,
  w: number,
  dashes: Part[],
  rect: PixelRect,
) {
  for (const left of dashes.filter((p) => p.rect.x < rect.x))
    for (const right of dashes.filter((p) => p.rect.x >= rect.x + rect.w - 2)) {
      const a = left.rect,
        b = right.rect;
      if (
        Math.abs(a.y + a.h / 2 - b.y - b.h / 2) <= 2.1 &&
        a.w > 0.55 * b.w &&
        a.w < 1.82 * b.w
      ) {
        mergeMaskIntoPage(core, w, a, left.data);
        mergeMaskIntoPage(core, w, b, right.data);
      }
    }
}

/** Read a single caption printed in reverse or directly on opaque stock.
 * Eight disjoint samples must agree on the stock behind its native ink. */
export function measureQwenCaptionStock(
  bitmap: Buffer,
  size: { width: number; height: number },
  instance: InpaintingWindowMask,
): Caption | undefined {
  const box = maskBoundsInRect(instance.data, instance.bounds.w, {
    x: 0,
    y: 0,
    w: instance.bounds.w,
    h: instance.bounds.h,
  });
  if (!box) return;
  const selected = {
    ...box,
    x: box.x + instance.bounds.x,
    y: box.y + instance.bounds.y,
  };
  if (
    box.h >= 16 &&
    box.h <= 122 &&
    box.w >= 42 &&
    box.w <= 435 &&
    box.w >= 1.15 * box.h
  ) {
    const bounds = expandRect(
      selected,
      size.width,
      size.height,
      Math.min(132, Math.ceil(1.55 * box.h) + 5),
    );
    const plate = measureDiamondCaption(
      bitmap,
      size.width,
      selected,
      instance,
      bounds,
    );
    if (plate) return plate;
  }
  return measureCaptionBand(bitmap, size, selected, instance);
}

function measureCaptionBand(
  bitmap: Buffer,
  size: { width: number; height: number },
  box: PixelRect,
  instance: InpaintingWindowMask,
): Caption | undefined {
  if (box.h > 75)
    return measureVerticalCaptions(
      bitmap,
      size,
      box,
      instance,
      expandRect(box, size.width, size.height, 85),
    );
  if (box.h < 7 || box.w < Math.max(74, 5 * box.h)) return;
  const bounds = expandRect(
    box,
    size.width,
    size.height,
    Math.round(1.35 * box.h),
  );
  const rect = { ...box, x: box.x - bounds.x, y: box.y - bounds.y };
  const gray = nativeLuminance(bitmap, size.width, bounds),
    local = projectWindowMask(instance, bounds);
  for (const inverse of [false, true]) {
    const tone = inverse ? gray.map((v) => 255 - v) : gray;
    const band = findCaptionBand(tone, bounds.w, rect);
    if (!band) continue;
    const start = band.start * bounds.w,
      end = band.end * bounds.w;
    const strip = tone.subarray(start, end),
      marked = local.subarray(start, end);
    const ink = strip.map((v) => Number(v > 90)),
      distance = distanceToMask(ink, bounds.w, band.end - band.start);
    const level = measureStock(strip, marked, distance, bounds.w, rect);
    if (level === undefined) continue;
    const data = captionStrokes(ink, marked, bounds.w, rect);
    if (!data) continue;
    const region = {
      ...bounds,
      y: bounds.y + band.start,
      h: band.end - band.start,
    };
    if (!neutralStock(bitmap, size.width, region, rect)) return;
    return { bounds: region, data, level: inverse ? 255 - level : level };
  }
}

function neutralStock(
  bitmap: Buffer,
  stride: number,
  region: PixelRect,
  rect: PixelRect,
) {
  let colored = 0;
  for (let y = 0; y < region.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const p = 4 * ((region.y + y) * stride + region.x + x);
      colored += Number(
        Math.max(bitmap[p], bitmap[p + 1], bitmap[p + 2]) -
          Math.min(bitmap[p], bitmap[p + 1], bitmap[p + 2]) >
          6,
      );
    }
  return colored <= 0.018 * region.h * rect.w;
}

export function refineQwenCaptionStock(
  source: Buffer,
  prediction: Buffer,
  stencil: Uint8Array,
  width: number,
  height: number,
) {
  const caption = measureQwenCaptionStock(
    source,
    { width, height },
    { data: stencil, bounds: { x: 0, y: 0, w: width, h: height } },
  );
  if (!caption) return;
  const checked = verifyDecodedCaption(source, prediction, width, caption);
  if (!checked) return;
  const { pixels, restorePlate } = checked;
  const { level } = caption;
  const out = Buffer.from(source);
  for (const [i, p] of pixels) {
    if (restorePlate && Math.abs(source[p + 1] - level) <= 4) continue;
    for (let c = 0; c < 3; c++)
      out[p + c] =
        caption.levels?.[i] ??
        Math.max(
          0,
          Math.min(
            255,
            Math.max(level - 1, Math.min(level + 1, prediction[p + c])),
          ),
        );
  }
  return out;
}

export function measureSelectedCaption(
  bitmap: Buffer,
  options: {
    width: number;
    height: number;
    sourceRect: PixelRect;
    regionMask: InpaintingWindowMask;
  },
) {
  const rect = options.sourceRect;
  // Padding for model context can cross both long edges of a reverse-printed
  // subtitle. Measure the exposed stock relative to the selected lettering.
  if (rect.h >= 7 && rect.h <= 75 && rect.w >= Math.max(74, 5 * rect.h)) {
    const caption = measureQwenCaptionStock(bitmap, options, {
      bounds: rect,
      data: projectWindowMask(options.regionMask, rect),
    });
    if (caption) return caption;
  }
  return measureQwenCaptionStock(bitmap, options, options.regionMask);
}
