import {
  distanceFromMaskBoundary,
  erodeBinaryMask,
} from "../bubbleLayout/bubbleDistanceTransform";
import { fillEnclosedMaskHoles } from "../bubbleLayout/bubbleMaskComponents";
import { maskBoundsInRect } from "./imageRaster";
import { expandRect, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { maskComponents } from "./rasterMasks";
import { isStandaloneEllipsis } from "./qwenBalloonEllipsis";

type Component = ReturnType<typeof maskComponents>[number];
type Stroke = {
  rect: PixelRect;
  pixels: number[];
  owned: number;
  near: number;
  far: number;
};

/** An isolated exclamation sometimes receives a text mask without its balloon
 * label. Require both parts of the mark and independently verify the stock. */
export function restoreEnclosedQwenPunctuation(
  source: Buffer,
  stencil: Uint8Array,
  width: number,
  height: number,
) {
  const bounds = maskBoundsInRect(stencil, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  if (!bounds || bounds.h < 12 || bounds.h > 84 || bounds.w > 0.85 * bounds.h)
    return;
  const box = expandRect(bounds, width, height, 6);
  const selected = new Uint8Array(box.w * box.h);
  const pixel = (i: number) =>
    (box.y + Math.floor(i / box.w)) * width + box.x + (i % box.w);
  const tone = Uint8Array.from({ length: box.w * box.h }, (_, i) => {
    const p = pixel(i);
    const offset = p * 4;
    selected[i] = Number(Boolean(stencil[p]));
    return Math.max(source[offset], source[offset + 1], source[offset + 2]);
  });
  const distance = distanceToMask(selected, box.w, box.h);
  // Downsampling can cover the gaps between consecutive dots with pale ink.
  // Each darker component still needs a witness from the original selection.
  for (const level of [210, 175]) {
    const ink = tone.map((v) => Number(v < level));
    const parts = maskComponents(ink, box.w, box.h, 1);
    if (!isSelectedPunctuation(parts, box, distance)) continue;
    const full = new Uint8Array(stencil.length);
    ink.forEach((on, i) => {
      if (on) full[pixel(i)] = 1;
    });
    return restoreEnclosedQwenPaper(source, full, width, height, true);
  }
}

function isSelectedPunctuation(
  parts: Component[],
  box: PixelRect,
  distance: Float32Array,
) {
  const [stem, dot] = parts.slice().sort((a, b) => a.rect.y - b.rect.y);
  const shaped =
    (parts.length === 2 && isExclamationPair(stem, dot)) ||
    isStandaloneEllipsis(parts);
  return shaped && parts.every((p) => ownsPunctuationStroke(p, box, distance));
}

function ownsPunctuationStroke(
  part: Component,
  bounds: PixelRect,
  distance: Float32Array,
) {
  const { x, y, w, h } = part.rect;
  if (!x || !y || x + w >= bounds.w || y + h >= bounds.h) return false;
  let selected = 0;
  for (let i = 0; i < part.data.length; i++) {
    if (!part.data[i]) continue;
    const index = (y + Math.floor(i / w)) * bounds.w + x + (i % w);
    if (distance[index] > 4.3) return false;
    selected += Number(distance[index] === 0);
  }
  return selected >= Math.max(1, 0.08 * part.area);
}

export function isExclamationPair(stem: Component, dot: Component) {
  const bar = stem.rect,
    point = dot.rect;
  const gap = point.y - bar.y - bar.h;
  return (
    bar.h >= 1.6 * bar.w &&
    point.h >= 3 &&
    Math.min(point.w, point.h) >= 0.62 * Math.max(point.w, point.h) &&
    dot.area >= 0.5 * point.w * point.h &&
    stem.area >= 1.65 * dot.area &&
    stem.area <= 12 * dot.area &&
    gap >= 0 &&
    gap <= 0.65 * bar.h &&
    Math.abs(point.x + point.w / 2 - bar.x - bar.w / 2) <= 0.57 * bar.h
  );
}

/** A joined speech balloon can contain several columns with tiny furigana.
 * Its closed paper boundary is independent evidence when a tight text stencil
 * samples only part of a character. Never sample across that boundary. */
export function restoreEnclosedQwenPaper(
  source: Buffer,
  stencil: Uint8Array,
  width: number,
  height: number,
  punctuation = false,
) {
  const gray = Uint8Array.from(
    stencil,
    (_, i) =>
      (29 * source[i * 4] + 150 * source[i * 4 + 1] + 77 * source[i * 4 + 2]) /
      256,
  );
  const bright = gray.map((g, i) =>
    Number(g >= 228 && source[i * 4 + 3] === 255),
  );
  const selected = gray.map((g, i) => Number(g < 210 && Boolean(stencil[i])));
  const total = selected.reduce((a, b) => a + b, 0);
  const minimum = punctuation ? 12 : 35;
  if (total < minimum) return;
  const distance = distanceToMask(stencil, width, height);
  const out = Buffer.from(source);
  let covered = 0;
  for (const field of maskComponents(bright, width, height, 400)) {
    const { x, y, w, h } = field.rect;
    if (
      x === 0 ||
      y === 0 ||
      x + w === width ||
      y + h === height ||
      field.area < 0.4 * w * h
    )
      continue;
    covered += restoreBalloonField(field, {
      width,
      source,
      out,
      selected,
      gray,
      distance,
      punctuation,
      minimum,
    });
  }
  return covered >= 0.975 * total ? out : undefined;
}

function restoreBalloonField(
  field: Component,
  context: {
    width: number;
    source: Buffer;
    out: Buffer;
    selected: Uint8Array;
    gray: Uint8Array;
    distance: Float32Array;
    punctuation: boolean;
    minimum: number;
  },
) {
  const { width, source, out, selected, gray, distance } = context;
  const { x, y, w, h } = field.rect;
  const pixels = Int32Array.from(
    field.data,
    (_, i) => (y + Math.floor(i / w)) * width + x + (i % w),
  );
  const interior = erodeBinaryMask(
    fillEnclosedMaskHoles(field.data, w, h),
    w,
    h,
    1.5,
  );
  const count = interior.reduce((n, v, i) => n + v * selected[pixels[i]], 0);
  if (count < context.minimum) return 0;
  const color = measureBalloonPaper(field, pixels, source);
  if (!color) return 0;
  const holes = interior.map((v, i) => Number(v && !field.data[i]));
  const strokes = maskComponents(holes, w, h, 1).map((part) =>
    measureStroke(part, w, pixels, selected, gray, distance),
  );
  const ink = context.punctuation
    ? confirmedPunctuationInk(strokes, pixels.length)
    : classifyBalloonStrokes(strokes, w, h, distance, pixels);
  if (!ink) return 0;
  const matched = ink.reduce((n, v, i) => n + v * selected[pixels[i]], 0);
  if (matched < 0.97 * count) return 0;

  const toInk = distanceToMask(ink, w, h);
  const other = field.data.map((v, i) => Number(!v && !ink[i]));
  const toOther = distanceToMask(other, w, h);
  for (let i = 0; i < pixels.length; i++) {
    if (
      interior[i] &&
      toInk[i] <= 4.2 &&
      toInk[i] < toOther[i] &&
      source[4 * pixels[i] + 3] === 255
    )
      out.set(color, 4 * pixels[i]);
  }
  return matched;
}

function confirmedPunctuationInk(strokes: Stroke[], length: number) {
  const ink = new Uint8Array(length);
  for (const s of strokes) {
    if (!s.owned) continue;
    // A pencil line connected to a selected dot is not part of the punctuation.
    if (s.far > 3.6 || s.near < 0.97) return;
    for (const i of s.pixels) ink[i] = 1;
  }
  return ink;
}

function measureBalloonPaper(
  field: Component,
  pixels: Int32Array,
  source: Buffer,
) {
  const d = distanceFromMaskBoundary(field.data, field.rect.w, field.rect.h);
  const bank = pixels.filter((_, i) => d[i] >= 4.5);
  if (bank.length < Math.max(160, 0.24 * field.area)) return;
  const color = [0, 1, 2].map((c) => {
    const channel = Uint8Array.from(bank, (p) => source[p * 4 + c]).sort();
    const low = channel[Math.floor(0.05 * channel.length)],
      high = channel[Math.floor(0.95 * channel.length)];
    return low >= 249 && high - low <= 4 ? channel[bank.length >> 1] : -1;
  });
  return color.includes(-1) ? undefined : color;
}

function measureStroke(
  part: Component,
  width: number,
  page: Int32Array,
  selected: Uint8Array,
  gray: Uint8Array,
  distance: Float32Array,
): Stroke {
  const pixels: number[] = [];
  let core = 0,
    owned = 0,
    near = 0,
    far = 0;
  part.data.forEach((on, i) => {
    if (!on) return;
    const j =
      (part.rect.y + Math.floor(i / part.rect.w)) * width +
      part.rect.x +
      (i % part.rect.w);
    pixels.push(j);
    const p = page[j];
    far = Math.max(far, distance[p]);
    if (gray[p] >= 210) return;
    core++;
    owned += selected[p];
    near += Number(distance[p] <= 3.3);
  });
  return {
    rect: part.rect,
    pixels,
    owned: owned / Math.max(1, core),
    near: near / Math.max(1, core),
    far,
  };
}

function classifyBalloonStrokes(
  strokes: Stroke[],
  width: number,
  height: number,
  distance: Float32Array,
  page: Int32Array,
) {
  const ink = new Uint8Array(page.length),
    small: PixelRect[] = [],
    pending: Stroke[] = [];
  const accept = (stroke: Stroke) => {
    for (const i of stroke.pixels) ink[i] = 1;
    if (isSmallStroke(stroke, 10, 12, 48)) small.push(stroke.rect);
  };
  let letters = 0;
  for (const s of strokes) {
    if (
      s.rect.w > Math.max(42, 0.3 * width) ||
      s.rect.h > Math.max(42, 0.3 * height)
    )
      continue;
    if (s.owned < 0.2 || s.near < 0.91) {
      pending.push(s);
      continue;
    }
    accept(s);
    letters += Number(s.rect.w >= 5 && s.rect.h >= 6 && s.pixels.length >= 18);
  }
  if (letters < 2) return;
  const near = distanceToMask(ink, width, height);
  completeBalloonRuby(
    pending,
    { near, small, ink, width, distance, page },
    accept,
  );
  return ink;
}

function isSmallStroke(s: Stroke, w: number, h: number, area: number) {
  return s.rect.w <= w && s.rect.h <= h && s.pixels.length <= area;
}

function completeBalloonRuby(
  pending: Stroke[],
  context: {
    near: Float32Array;
    small: PixelRect[];
    ink: Uint8Array;
    width: number;
    distance: Float32Array;
    page: Int32Array;
  },
  accept: (s: Stroke) => void,
) {
  const { near, small, ink, width, distance, page } = context;
  for (const s of pending) {
    if (!isSmallStroke(s, 10, 12, 48)) continue;
    if (s.pixels.every((i) => near[i] <= 11) && s.owned > 0 && s.far <= 5.3)
      accept(s);
  }
  // Require a native column of ruby and a separately selected main character
  // beside it before extending to a completely unselected mark.
  const ruby = small.slice();
  for (const s of pending) {
    if (!isSmallStroke(s, 8, 9, 36) || s.far > 10.3) continue;
    const close =
      s.pixels.every((i) => near[i] <= 9.9) &&
      s.pixels.some((i) => distance[page[i]] <= 3.5);
    if (close || isBesideConfirmedRuby(s.rect, ruby, ink, width)) accept(s);
  }
}

function isBesideConfirmedRuby(
  rect: PixelRect,
  ruby: PixelRect[],
  ink: Uint8Array,
  width: number,
) {
  const aligned = ruby.some(
    (r) =>
      Math.abs(rect.x + rect.w / 2 - r.x - r.w / 2) <= 2.6 &&
      Math.min(Math.abs(rect.y - r.y - r.h), Math.abs(rect.y + rect.h - r.y)) <=
        3,
  );
  if (!aligned) return false;
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = Math.max(0, rect.x - 16); x < rect.x - 3; x++)
      if (ink[y * width + x]) return true;
  return false;
}
