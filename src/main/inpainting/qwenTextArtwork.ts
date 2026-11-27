import { trimWindowMask } from "./koharuTypographyMask";
import { expandRect, mergeMaskIntoPage } from "./maskGeometry";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { distanceToMask } from "./pageMaskComposite";
import { maskComponents } from "./rasterMasks";
import { cropBitmapFromPage, maskBoundsInRect } from "./imageRaster";

type Ink = ReturnType<typeof maskComponents>[number];

/** Heavy two-tone display type can fill most of the selected area with
 * lettering. Encoding that image as a handwritten caption copies it back.
 * Measure the interiors of both ink tones on a quarter-resolution grid. */
export function hasTwoToneDisplayType(inputs: {
  original: Buffer;
  stencil: Uint8Array;
  width: number;
  height: number;
}) {
  const { original, stencil, width, height } = inputs;
  const bounds = maskBoundsInRect(stencil, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  if (!bounds || Math.min(bounds.w, bounds.h) < 250) return false;
  const cols = Math.ceil(bounds.w / 4),
    rows = Math.ceil(bounds.h / 4);
  const black = new Uint8Array(cols * rows),
    grey = new Uint8Array(black.length);
  let marked = 0,
    coloured = 0;
  for (let i = 0; i < black.length; i++) {
    const pos =
      (bounds.y + 4 * Math.floor(i / cols)) * width + bounds.x + 4 * (i % cols);
    const p = 4 * pos,
      b = original[p],
      g = original[p + 1],
      r = original[p + 2];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const selected = !!stencil[pos];
    marked += Number(selected);
    coloured += Number(selected && chroma > 14);
    const outside = !selected || chroma > 8;
    black[i] = Number(outside || g > 31);
    grey[i] = Number(outside || g < 55 || g > 129);
  }
  if (marked < 4000 || coloured > 0.012 * marked) return false;
  const radius = Math.max(1.5, (Math.min(bounds.w, bounds.h) * 0.013) / 4);
  const interior = (outside: Uint8Array) =>
    distanceToMask(outside, cols, rows).reduce(
      (n, d) => n + Number(d > radius),
      0,
    ) / marked;
  return interior(black) > 0.105 && interior(grey) > 0.045;
}

/** Large overprints on actual line art and halftone need the full illustrated
 * reference. The paper immediately outside the print distinguishes them
 * from ordinary dialogue on a flat field. */
export function isLargeIllustratedPrint(inputs: {
  original: Buffer;
  stencil: Uint8Array;
  width: number;
  height: number;
}) {
  const { original, stencil, width, height } = inputs;
  const bounds = maskBoundsInRect(stencil, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  if (
    !bounds ||
    Math.min(bounds.w, bounds.h) < 95 ||
    Math.max(bounds.w, bounds.h) < 180
  )
    return false;
  const { marked, dark, pale, coloured } = measurePrintedTones(
    original,
    stencil,
  );
  const fill = marked / (bounds.w * bounds.h);
  if (
    marked < 10600 ||
    fill <= 0.13 ||
    fill >= 0.91 ||
    coloured >= 0.07 * stencil.length
  )
    return false;
  if (dark <= 0.075 * marked || dark >= 0.76 * marked || pale <= 0.12 * marked)
    return false;
  return hasTexturedPrintBank(original, distanceToMask(stencil, width, height));
}

function measurePrintedTones(original: Buffer, stencil: Uint8Array) {
  let marked = 0,
    dark = 0,
    pale = 0,
    coloured = 0;
  for (let i = 0; i < stencil.length; i++) {
    const j = 4 * i;
    if (
      Math.max(original[j], original[j + 1], original[j + 2]) -
        Math.min(original[j], original[j + 1], original[j + 2]) >
      38
    )
      coloured++;
    if (!stencil[i]) continue;
    marked++;
    const gray =
      (29 * original[j] + 150 * original[j + 1] + 77 * original[j + 2]) / 256;
    dark += Number(gray < 105);
    pale += Number(gray > 225);
  }
  return { marked, dark, pale, coloured };
}

function hasTexturedPrintBank(original: Buffer, distance: Float32Array) {
  let count = 0,
    midtones = 0,
    total = 0,
    squared = 0;
  for (let i = 0; i < distance.length; i++) {
    if (distance[i] <= 6 || distance[i] >= 27) continue;
    const j = 4 * i,
      v =
        (29 * original[j] + 150 * original[j + 1] + 77 * original[j + 2]) / 256;
    count++;
    total += v;
    squared += v * v;
    midtones += Number(v >= 55 && v <= 216);
  }
  return (
    count > 100 &&
    midtones > 0.1 * count &&
    squared / count - (total / count) ** 2 > 18 ** 2
  );
}

/** Encode context at the working resolution, then write the edit on the
 * native grid. Decoder drift in neighbouring panel art must not be written
 * back merely because that art was visible in the model's input. */
export function compositeQwenArtwork(
  source: Buffer,
  prediction: Buffer,
  stencil: Uint8Array,
  width: number,
  height: number,
  weights?: Float32Array,
): Buffer {
  const alpha =
    weights ??
    distanceToMask(stencil, width, height).map((distance) =>
      Math.min(1, Math.max(0, (6 - distance) / 2)),
    );
  const result = Buffer.from(source);
  alpha.forEach((weight, index) => {
    if (!weight) return;
    const offset = index * 4;
    // At the very outside of a soft shoulder, rounding decoder variation
    // can alter an original ink dot by one shade even on intact artwork.
    if (!weights && weight < 0.25 && !stencil[index]) {
      const delta = Math.max(
        ...[0, 1, 2].map((c) =>
          Math.abs(prediction[offset + c] - source[offset + c]),
        ),
      );
      if (weight * delta <= 3) return;
    }
    for (let channel = 0; channel < 3; channel++) {
      const p = offset + channel;
      result[p] = Math.round(source[p] + weight * (prediction[p] - source[p]));
    }
  });
  return result;
}

/** A white keyline around typeset dialogue can separate the printed letters
 * from a flower, balloon border or strand running through the detector box. */
export function qwenTextArtworkWeights(
  source: Buffer,
  stencil: Uint8Array,
  width: number,
  height: number,
): Float32Array | undefined {
  const luminance = Uint8Array.from(stencil, (_, i) => {
    const p = i * 4;
    return (29 * source[p] + 150 * source[p + 1] + 77 * source[p + 2]) / 256;
  });
  const ink = luminance.map((value) => Number(value < 117));
  const layers = findTypesetInk(ink, stencil, width, height);
  if (!layers) return;
  const { type, pen, spans } = layers;
  const toType = distanceToMask(type, width, height);
  const toPen = distanceToMask(pen, width, height);
  if (!hasWhiteKeyline(luminance, toType, toPen)) return;
  spans.sort((a, b) => a - b);
  const radius = Math.min(24, Math.max(8, 0.82 * spans[spans.length >> 1]));
  return toType.map((d, i) => {
    const nearType = Math.min(1, Math.max(0, (radius - d) / 3));
    const p = toPen[i];
    const preservePen = d > p + 4 ? Math.min(1, Math.max(0, (p - 3.5) / 4)) : 1;
    return nearType * preservePen;
  });
}

function findTypesetInk(
  ink: Uint8Array,
  stencil: Uint8Array,
  width: number,
  height: number,
) {
  const type = new Uint8Array(stencil.length);
  const pen = new Uint8Array(stencil.length);
  const spans: number[] = [];
  let selected = 0;
  let printed = 0;
  for (const part of maskComponents(ink, width, height, 2)) {
    const pixels = componentPixels(part, width);
    const owned = pixels.reduce((n, i) => n + Number(Boolean(stencil[i])), 0);
    selected += owned;
    if (
      owned >= 0.8 * part.area &&
      part.area >= 3 &&
      insideCrop(part, width, height)
    ) {
      for (const pixel of pixels) type[pixel] = 1;
      printed += owned;
      spans.push(Math.max(part.rect.w, part.rect.h));
    } else if (owned < 0.28 * part.area && part.area >= 20) {
      for (const pixel of pixels) pen[pixel] = 1;
    }
  }
  if (spans.length < 6 || printed < 0.84 * selected || !pen.some(Boolean))
    return;
  return { type, pen, spans };
}

function componentPixels(part: Ink, width: number) {
  const pixels: number[] = [];
  const { x, y, w } = part.rect;
  part.data.forEach((set, i) => {
    if (set) pixels.push((y + Math.floor(i / w)) * width + x + (i % w));
  });
  return pixels;
}

function insideCrop({ rect }: Ink, width: number, height: number) {
  return (
    rect.x > 0 &&
    rect.y > 0 &&
    rect.x + rect.w < width &&
    rect.y + rect.h < height
  );
}

function hasWhiteKeyline(
  gray: Uint8Array,
  type: Float32Array,
  pen: Float32Array,
) {
  let near = 0,
    nearWhite = 0,
    far = 0,
    farWhite = 0;
  for (let i = 0; i < gray.length; i++) {
    if (pen[i] <= 1) continue;
    const white = Number(gray[i] > 242);
    if (type[i] >= 1.5 && type[i] < 2.5) {
      near++;
      nearWhite += white;
    } else if (type[i] >= 6.5 && type[i] < 9.5) {
      far++;
      farWhite += white;
    }
  }
  return (
    near >= 32 &&
    far >= 32 &&
    nearWhite / near >= 0.78 &&
    nearWhite / near - farWhite / far > 0.1
  );
}

export function qwenCropCompositeWeights(
  {
    original,
    stencil,
    width,
    height,
  }: { original: Buffer; stencil: Uint8Array; width: number; height: number },
  speech: boolean | undefined,
  crop?: { sourceReference: boolean },
) {
  if (speech) return qwenTextArtworkWeights(original, stencil, width, height);
  if (crop?.sourceReference)
    return Float32Array.from(stencil, (on) => Number(!!on));
}

export function largeIllustratedWindow(
  bitmap: Buffer,
  pageWidth: number,
  pageHeight: number,
  mask: InpaintingWindowMask,
) {
  const core = trimWindowMask(mask).bounds;
  if (Math.min(core.w, core.h) < 95 || Math.max(core.w, core.h) < 180)
    return false;
  const box = expandRect(core, pageWidth, pageHeight, 32);
  return isLargeIllustratedPrint({
    original: cropBitmapFromPage(bitmap, pageWidth, box),
    stencil: projectWindowMask(mask, box),
    width: box.w,
    height: box.h,
  });
}

/** Large grayscale display faces can bleach the illustration well beyond
 * their detector outline. Measure the falloff at three distances and keep
 * original drawing ink that continues from outside the optical shoulder. */
export function washedDisplayTitle(
  bitmap: Buffer,
  width: number,
  height: number,
  selected: InpaintingWindowMask,
) {
  const { w, h } = selected.bounds;
  if (w < Math.max(480, 0.42 * width, 1.65 * h) || h < 120 || w > 6 * h) return;
  const radius = Math.min(32, Math.max(12, Math.round(0.05 * h)));
  const box = expandRect(selected.bounds, width, height, 2 * radius + 8);
  if (box.w * box.h > 1_450_000) return;
  const core = projectWindowMask(selected, box);
  const src = cropBitmapFromPage(bitmap, width, box);
  const { marked, pale, coloured } = measurePrintedTones(src, core);
  if (
    marked < 0.19 * w * h ||
    marked > 0.77 * w * h ||
    pale < 0.2 * marked ||
    coloured > 0.01 * marked
  )
    return;
  const gray = core.map((_, i) => src[4 * i + 1]);
  const face = gray.map((level, i) => Number(!!core[i] && level < 150));
  const strokes = maskComponents(face, box.w, box.h, Math.round(0.002 * w * h));
  const large = strokes.filter(
    ({ rect }) => rect.w > 0.035 * w && rect.h > 0.085 * h,
  );
  if (large.length < 5 || large.length > 40) return;
  const distance = distanceToMask(core, box.w, box.h);
  if (!hasDisplayFalloff(gray, distance, radius)) return;
  const toDrawing = distanceToExposedDrawing(gray, distance, box, radius);
  return trimWindowMask({
    bounds: box,
    data: core.map((on, i) =>
      Number(on || (distance[i] < radius && toDrawing[i] > 1.7)),
    ),
  });
}

function distanceToExposedDrawing(
  gray: Uint8Array,
  distance: Float32Array,
  box: { w: number; h: number },
  radius: number,
) {
  const exposed = gray.map((level, i) => Number(level < 75 && distance[i] > 2));
  const drawing = new Uint8Array(gray.length);
  for (const part of maskComponents(exposed, box.w, box.h, 110)) {
    const { rect, data } = part;
    let outside = false,
      near = 0;
    data.forEach((on, i) => {
      if (!on) return;
      const d =
        distance[
          (rect.y + Math.floor(i / rect.w)) * box.w + rect.x + (i % rect.w)
        ];
      outside ||= d > radius + 8;
      near += Number(d < radius);
    });
    if (outside && near >= 5) mergeMaskIntoPage(drawing, box.w, rect, data);
  }
  return distanceToMask(drawing, box.w, box.h);
}

function hasDisplayFalloff(
  gray: Uint8Array,
  distance: Float32Array,
  radius: number,
) {
  const bands = [
    [0, 0.29],
    [0.61, 0.95],
    [1.58, 2.35],
  ].map(([lo, hi]) => {
    let count = 0,
      dark = 0,
      white = 0;
    for (let i = 0; i < gray.length; i++) {
      if (distance[i] <= lo * radius || distance[i] > hi * radius) continue;
      count++;
      dark += Number(gray[i] < 155);
      white += Number(gray[i] > 244);
    }
    return { count, dark: dark / count, white: white / count };
  });
  const [inner, middle, outer] = bands;
  return (
    bands.every((b) => b.count >= 400) &&
    inner.white >= 0.7 &&
    inner.dark < 0.065 &&
    middle.dark > inner.dark + 0.014 &&
    outer.dark > middle.dark + 0.025 &&
    outer.white < inner.white - 0.065
  );
}
