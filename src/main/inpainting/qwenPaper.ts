import { distanceFromMaskBoundary } from "../bubbleLayout/bubbleDistanceTransform";
import { maskComponents } from "./rasterMasks";
import { restoreSelectedSignType } from "./qwenSignType";
import { restoreRuledSoundPaper } from "./qwenRuledPaper";
import { restoreRuledHeader } from "./qwenRuledHeader";
import { missingBalloonReadings } from "./qwenBalloonReadings";
import { isStandaloneEllipsis } from "./qwenBalloonEllipsis";
import type { PixelRect } from "./maskGeometry";
import {
  clearQwenPaperRinging,
  restoreFlatQwenText,
  restoreIsolatedSoundPaper,
} from "./qwenFlatText";
import {
  restoreEnclosedQwenPaper,
  restoreEnclosedQwenPunctuation,
} from "./qwenBalloonPaper";

type Component = ReturnType<typeof maskComponents>[number];
type Paper = [number, number, number];

/** Source BGRA bytes are at native resolution. A single textured or connected
 * drawing edge in the target can disqualify the entire paper shortcut. */
export function restoreQwenPaper(
  source: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
  speechBubble = true,
  illustration?: unknown,
): Buffer | undefined {
  if (!speechBubble) {
    const sound = restoreIsolatedSoundPaper(
      source,
      mask,
      width,
      height,
      illustration,
    );
    if (sound) return sound;
    const ruled = restoreRuledSoundPaper(
      source,
      mask,
      { width, height },
      illustration,
    );
    if (ruled) return ruled;
    const sign =
      restoreRuledHeader(source, mask, width, height) ??
      restoreSelectedSignType(source, mask, width, height);
    if (sign) return sign;
  }
  const paper = speechBubble
    ? recoverDialoguePaper(source, mask, width, height)
    : (restoreEnclosedQwenPunctuation(source, mask, width, height) ??
      (hasPrintedText(source, mask, width, height)
        ? restoreFlatQwenText(source, mask, width, height, true)
        : undefined));
  if (paper) {
    if (speechBubble) completeSmallReadings(source, paper, mask, width, height);
    clearQwenPaperRinging(source, paper, mask, width, height);
  }
  return paper;
}

function recoverDialoguePaper(
  source: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
) {
  return (
    restoreFlatQwenText(source, mask, width, height) ??
    restoreSeparatedLetters(source, mask, width, height) ??
    restoreEnclosedQwenPaper(source, mask, width, height) ??
    restoreFlatQwenText(source, mask, width, height, true)
  );
}

function completeSmallReadings(
  source: Buffer,
  paper: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
) {
  const { dark } = classifyInk(source, mask);
  const marks = missingBalloonReadings(
    source,
    paper,
    maskComponents(dark, width, height, 4),
    mask,
    width,
    height,
  );
  if (!marks.length) return;
  const confirmed = mask.map((v, i) =>
    Number(v || (dark[i] && paper[4 * i + 1] >= 245)),
  );
  for (const { rect, data } of marks)
    data.forEach((on, i) => {
      if (on)
        confirmed[
          (rect.y + Math.floor(i / rect.w)) * width + rect.x + (i % rect.w)
        ] = 1;
    });
  const clearance = distanceFromMaskBoundary(
    dark.map((v) => 1 - v),
    width,
    height,
  );
  const unclean = dark.map((v, i) => Number(v || clearance[i] <= 2.5));
  for (const part of marks) {
    const sample = sampleAroundStroke(
      part,
      source,
      dark,
      confirmed,
      width,
      height,
      unclean,
    );
    if (!sample || Math.min(...sample.color) < 249) continue;
    for (const pixel of sample.pixels) paper.set(sample.color, 4 * pixel);
  }
}

/** A multi-lobed speech balloon can extend beyond the crop, leaving its text
 * without an enclosure label. Independently aligned columns establish that the
 * existing paper measurement may inspect the small reading marks beside them. */
function hasPrintedText(
  source: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
) {
  const ink = mask.map((v, i) => Number(v && source[4 * i + 1] < 172));
  const parts = maskComponents(ink, width, height, 1);
  if (isStandaloneEllipsis(parts)) return true;
  const glyphs = parts
    .filter((p) => p.area >= 18)
    .map((p) => p.rect)
    .filter(
      ({ w, h }) =>
        w >= 6 && w <= 43 && h >= 8 && h <= 50 && w > 0.35 * h && w < 1.6 * h,
    )
    .sort((a, b) => a.y - b.y);
  if (singleHandwrittenColumn(glyphs) || hasAlignedColumns(glyphs)) return true;
  if (parts.length < 4 || parts.length > 70) return false;
  // The antialiasing of a hand-inked voicing mark can touch its syllable. The
  // solid cores still show the two separate strokes and their original spacing.
  const cores = ink.map((on, i) => Number(on && source[4 * i + 1] < 122));
  return hasDetachedKanaAccent(maskComponents(cores, width, height, 4));
}

function hasDetachedKanaAccent(parts: Component[]) {
  const marks = parts.filter(
    ({ rect: { w, h }, area }) =>
      w >= 2 && h >= 7 && h <= 29 && w < 0.59 * h && area >= 0.43 * w * h,
  );
  const letters = parts.filter(
    ({ rect: { w, h }, area }) => w >= 11 && h >= 14 && area >= 30,
  );
  if (letters.length < 2 || marks.length > 25) return false;
  return marks.some(({ rect: a }) =>
    marks.some(({ rect: b }) => {
      const gap = b.x - a.x - a.w;
      const paired =
        gap >= 0 &&
        gap < a.w &&
        Math.abs(b.y - a.y) <= 0.32 * a.h &&
        Math.abs(b.h - a.h) < 0.38 * a.h;
      if (!paired) return false;
      return letters.some(
        ({ rect: body }) =>
          body.h > 1.6 * a.h &&
          body.x < a.x &&
          Math.abs(body.x + body.w - a.x) < 0.52 * body.w &&
          body.y > a.y - 0.24 * body.h &&
          body.y < a.y + 0.57 * body.h,
      );
    }),
  );
}

function hasAlignedColumns(glyphs: PixelRect[]) {
  if (glyphs.length < 6 || glyphs.length > 240) return false;
  const columns: { center: number; width: number }[] = [];
  for (const letter of glyphs) {
    const center = letter.x + letter.w / 2;
    let previous = -Infinity;
    let count = 0;
    for (const other of glyphs) {
      const y = other.y + other.h / 2;
      if (
        Math.abs(other.x + other.w / 2 - center) >=
          Math.max(2.5, 0.24 * letter.w) ||
        other.h <= 0.52 * letter.h ||
        other.h >= 1.8 * letter.h ||
        y - previous <= 0.68 * letter.h
      )
        continue;
      previous = y;
      count++;
    }
    if (count < 3) continue;
    if (
      columns.some(
        (p) =>
          Math.abs(p.center - center) >
          Math.max(11, 0.78 * (p.width + letter.w)),
      )
    )
      return true;
    columns.push({ center, width: letter.w });
  }
  return false;
}

/** A short, unenclosed aside may also have a single slightly inclined
 * baseline. Every measured letter must agree with its pitch and direction. */
function singleHandwrittenColumn(glyphs: PixelRect[]) {
  if (glyphs.length < 4 || glyphs.length > 20) return false;
  const cy = (p: PixelRect) => p.y + p.h / 2;
  const cx = (p: PixelRect) => p.x + p.w / 2;
  const first = glyphs[0],
    last = glyphs[glyphs.length - 1];
  const height = glyphs.reduce((total, p) => total + p.h, 0) / glyphs.length;
  const extent = cy(last) - cy(first);
  if (extent < 2.65 * height) return false;
  const slope = (cx(last) - cx(first)) / extent;
  if (Math.abs(slope) > 0.26) return false;
  return glyphs.every((p, i) => {
    const step = i ? (cy(p) - cy(glyphs[i - 1])) / height : 1;
    const axis = cx(first) + (cy(p) - cy(first)) * slope;
    return (
      step >= 0.55 &&
      step <= 2.65 &&
      p.h >= 0.52 * height &&
      p.h <= 1.7 * height &&
      Math.abs(cx(p) - axis) <= Math.max(2, 0.29 * p.w)
    );
  });
}

function restoreSeparatedLetters(
  source: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
) {
  const { dark, printed, selected } = classifyInk(source, mask);
  if (printed < 8 || printed > selected / 2) return;
  const components = maskComponents(dark, width, height, 3);
  const fill = new Uint8Array(mask.length);
  const colors: Paper[] = [];
  let covered = 0;
  let hasLetter = false;
  for (const component of components) {
    const owned = selectedStrokePixels(component, mask, width, height);
    if (owned === 0) continue;
    const paper = sampleAroundStroke(
      component,
      source,
      dark,
      mask,
      width,
      height,
    );
    if (!paper) continue;
    covered += owned;
    hasLetter ||= isLetterSize(component);
    colors.push(paper.color);
    for (const i of paper.pixels) fill[i] = 1;
  }
  if (!hasLetter || colors.length < 3 || covered < 0.976 * printed) return;
  return fillWithMeasuredPaper(source, fill, colors);
}

function fillWithMeasuredPaper(
  source: Buffer,
  fill: Uint8Array,
  colors: Paper[],
) {
  const color = [0, 1, 2].map((channel) => {
    const values = colors.map((c) => c[channel]).sort((a, b) => a - b);
    return values[values.length - 1] - values[0] <= 3
      ? values[Math.floor(values.length / 2)]
      : -1;
  });
  if (color.includes(-1)) return;
  const result = Buffer.from(source);
  for (let i = 0; i < fill.length; i++) {
    if (!fill[i]) continue;
    for (let c = 0; c < 3; c++) result[i * 4 + c] = color[c];
  }
  return result;
}

function classifyInk(source: Buffer, mask: Uint8Array) {
  const dark = new Uint8Array(mask.length);
  let printed = 0;
  let selected = 0;
  for (let i = 0; i < mask.length; i++) {
    const p = i * 4;
    const luminance =
      (29 * source[p] + 150 * source[p + 1] + 77 * source[p + 2]) / 256;
    dark[i] = Number(luminance < 218);
    if (mask[i]) {
      selected++;
      printed += dark[i];
    }
  }
  return { dark, printed, selected };
}

function isLetterSize({ rect, area }: Component) {
  return rect.w >= 5 && rect.h >= 6 && area >= 18;
}

function selectedStrokePixels(
  component: Component,
  mask: Uint8Array,
  width: number,
  height: number,
) {
  const { x, y, w, h } = component.rect;
  if (x === 0 || y === 0 || x + w >= width || y + h >= height) return 0;
  let owned = 0;
  for (let i = 0; i < component.data.length; i++) {
    const pageIndex = (y + Math.floor(i / w)) * width + x + (i % w);
    if (component.data[i] && mask[pageIndex]) owned++;
  }
  return owned >= component.area * 0.65 ? owned : 0;
}

function sampleAroundStroke(
  component: Component,
  source: Buffer,
  dark: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  unclean = dark,
) {
  const { x, y, w, h } = component.rect;
  // Distance transform seeds its outer border. The extra ring keeps that
  // border outside the entire eleven-pixel sampling neighbourhood.
  const { inverse, distance, stride, margin } = strokeDistances(component);
  const hist = Array.from({ length: 3 }, () => new Uint32Array(256));
  const pixels: number[] = [];
  let samples = 0;
  let outsideRing = 0;
  let outsideInk = 0;
  for (let v = Math.max(-11, -y); v < Math.min(h + 11, height - y); v++) {
    for (let u = Math.max(-11, -x); u < Math.min(w + 11, width - x); u++) {
      const i = (y + v) * width + x + u,
        cell = (v + margin) * stride + u + margin,
        d = distance[cell];
      if (d < 3.9 && (!dark[i] || !inverse[cell])) pixels.push(i);
      if (d <= 5 || d >= 11) continue;
      if (!mask[i]) {
        outsideRing++;
        outsideInk += dark[i];
      }
      if (unclean[i]) continue;
      for (let c = 0; c < 3; c++) hist[c][source[i * 4 + c]]++;
      samples++;
    }
  }
  return finishStrokeSample(hist, samples, outsideRing, outsideInk, pixels);
}

function finishStrokeSample(
  hist: Uint32Array[],
  samples: number,
  outsideRing: number,
  outsideInk: number,
  pixels: number[],
) {
  if (samples < 12 || (outsideRing >= 12 && outsideInk > 0.09 * outsideRing))
    return;
  const color = measuredColor(hist, samples);
  return color ? { color, pixels } : undefined;
}

function measuredColor(hist: Uint32Array[], samples: number) {
  const color: Paper = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const median = quantile(hist[c], samples, 0.5);
    if (
      median < 243 ||
      median - quantile(hist[c], samples, 0.08) > 8 ||
      quantile(hist[c], samples, 0.92) - median > 8
    )
      return;
    color[c] = median;
  }
  return color;
}

function strokeDistances(component: Component) {
  const { w, h } = component.rect;
  const margin = 24,
    stride = w + 2 * margin,
    rows = h + 2 * margin;
  const inverse = new Uint8Array(stride * rows).fill(1);
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++)
      if (component.data[v * w + u])
        inverse[(margin + v) * stride + margin + u] = 0;
  const distance = distanceFromMaskBoundary(inverse, stride, rows);
  return { inverse, distance, stride, margin };
}

function quantile(histogram: Uint32Array, size: number, fraction: number) {
  const target = Math.ceil(size * fraction);
  let count = 0;
  for (let i = 0; i < histogram.length; i++) {
    count += histogram[i];
    if (count >= target) return i;
  }
  return 255;
}
