import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { PixelRect } from "./maskGeometry";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import { maskComponents } from "./rasterMasks";
type InkPart = ReturnType<typeof maskComponents>[number];
type Strokes = {
  dots: InkPart[];
  letters: InkPart[];
  fragments: InkPart[];
  ends: Set<InkPart>;
};

/** The original scan confirms the pitch of the ellipsis between two measured
 * detector witnesses. The preceding glyph and paper must belong to the balloon. */
export function registerBalloonEllipsis(
  bitmap: Buffer,
  pageWidth: number,
  instance: InpaintingWindowMask,
  selection: PixelRect,
  balloon: InpaintingWindowMask,
) {
  const { w, h } = selection;
  if (w * h > 600_000 || Math.max(w, h) < 25) return;
  const owned = projectWindowMask(instance, selection);
  const paper = projectWindowMask(balloon, selection);
  const tone = Uint8Array.from(owned, (_, i) => {
    const p =
      4 *
      ((selection.y + Math.floor(i / w)) * pageWidth + selection.x + (i % w));
    return Math.max(bitmap[p], bitmap[p + 1], bitmap[p + 2]);
  });
  const parts = maskComponents(
    tone.map((v) => Number(v < 150)),
    w,
    h,
    3,
  );
  const strokes = classifyStrokes(parts, owned, tone, paper, w, h);
  if (
    strokes.ends.size < 2 ||
    !strokes.letters.length ||
    strokes.dots.length > 180
  )
    return;
  const data = new Uint8Array(owned.length);
  for (const first of strokes.ends) {
    for (const vertical of [true, false]) {
      const run = confirmedRun(first, vertical, strokes);
      for (const part of run) writePart(part, data, w);
    }
  }
  if (data.some(Boolean)) return { bounds: selection, data };
}
function classifyStrokes(
  parts: InkPart[],
  owned: Uint8Array,
  tone: Uint8Array,
  paper: Uint8Array,
  w: number,
  h: number,
): Strokes {
  const dots: InkPart[] = [],
    letters: InkPart[] = [],
    fragments: InkPart[] = [],
    ends = new Set<InkPart>();
  const shoulder = dilateBinaryMaskDisk(owned, w, h, 3);
  for (const part of parts) {
    const r = part.rect;
    if (
      Math.min(r.w, r.h) >= 7 &&
      Math.max(r.w, r.h) <= 65 &&
      part.area >= 28 &&
      countPartOverlap(part, owned, w) >= 0.6 * part.area
    )
      letters.push(part);
    else if (isPaperDot(part, tone, paper, w, h)) {
      dots.push(part);
      if (countPartOverlap(part, shoulder, w) > 0) ends.add(part);
    } else if (isOwnedFragment(part, owned, w)) fragments.push(part);
  }
  return { dots, letters, fragments, ends };
}
function isOwnedFragment(part: InkPart, owned: Uint8Array, width: number) {
  const { w, h } = part.rect;
  const longest = Math.max(w, h);
  return (
    Math.min(w, h) >= 3 &&
    longest >= 7 &&
    longest <= 32 &&
    part.area >= 12 &&
    countPartOverlap(part, owned, width) >= 0.6 * part.area
  );
}
function writePart(p: InkPart, destination: Uint8Array, width: number) {
  const { x, y, w } = p.rect;
  p.data.forEach((v, i) => {
    if (v) destination[(y + Math.floor(i / w)) * width + x + (i % w)] = 1;
  });
}
function confirmedRun(first: InkPart, vertical: boolean, strokes: Strokes) {
  const along = (p: InkPart) =>
    vertical ? p.rect.y + p.rect.h / 2 : p.rect.x + p.rect.w / 2;
  const across = (p: InkPart) =>
    vertical ? p.rect.x + p.rect.w / 2 : p.rect.y + p.rect.h / 2;
  const size = Math.max(first.rect.w, first.rect.h);
  const preceded = strokes.letters.some((p) => {
    const r = p.rect,
      gap = along(first) - (vertical ? r.y + r.h : r.x + r.w);
    if (gap < 0 || gap > 4 * size) return false;
    const offset = across(first) - across(p);
    if (Math.abs(offset) <= 0.35 * (vertical ? r.w : r.h)) return true;
    // A kana such as い has separate left and right strokes. Their shared
    // baseline and the column between them locate the printed dot train.
    const extent = vertical ? r.h : r.w;
    if (Math.abs(offset) > 0.55 * extent) return false;
    return strokes.fragments.some(
      (other) =>
        Math.abs(along(other) - along(p)) <= 0.3 * extent &&
        (across(other) - across(first)) * offset > 0 &&
        Math.abs(across(other) - across(p)) <= extent &&
        (vertical ? other.rect.h : other.rect.w) >= 0.45 * extent,
    );
  });
  if (!preceded) return [];
  const rest = strokes.dots
    .filter(
      (p) =>
        along(p) > along(first) &&
        Math.abs(across(first) - across(p)) <= 1.5 &&
        similarDot(first, p),
    )
    .sort((a, b) => along(a) - along(b));
  if (!rest.length) return [];
  const pitch = along(rest[0]) - along(first);
  if (pitch < 1.6 * size || pitch > 4.8 * size) return [];
  const run = [first];
  for (const p of rest) {
    if (
      Math.abs(along(p) - along(run[run.length - 1]) - pitch) >
      Math.max(1.25, 0.15 * pitch)
    )
      break;
    run.push(p);
  }
  return run.length >= 3 &&
    run.length % 3 === 0 &&
    strokes.ends.has(run[run.length - 1])
    ? run
    : [];
}
function similarDot(a: InkPart, b: InkPart) {
  return (
    Math.abs(a.rect.w - b.rect.w) <= 2 &&
    Math.abs(a.rect.h - b.rect.h) <= 2 &&
    Math.min(a.area, b.area) >= 0.57 * Math.max(a.area, b.area)
  );
}

/** A standalone typeset pause can be the only ink selected in a blank panel.
 * Check the entire run, including its pitch, before attempting to sample paper. */
export function isStandaloneEllipsis(parts: InkPart[]) {
  if (
    parts.length < 3 ||
    parts.length > 12 ||
    parts.length % 3 !== 0 ||
    !parts.every((p) => smallRoundInk(p) && similarDot(parts[0], p))
  )
    return false;
  const centers = parts.map(({ rect: r }) => [r.x + r.w / 2, r.y + r.h / 2]);
  const span = (axis: number) => {
    const values = centers.map((p) => p[axis]);
    return Math.max(...values) - Math.min(...values);
  };
  const axis = span(0) >= span(1) ? 0 : 1;
  centers.sort((a, b) => a[axis] - b[axis]);
  const start = centers[0],
    end = centers[centers.length - 1];
  const pitch = (end[axis] - start[axis]) / (centers.length - 1);
  const stepAcross = (end[1 - axis] - start[1 - axis]) / (centers.length - 1);
  const size = Math.max(parts[0].rect.w, parts[0].rect.h);
  return (
    pitch >= 1.6 * size &&
    pitch <= 10 * size &&
    Math.abs(stepAcross) <= 0.13 * pitch &&
    centers.every(
      (p, i) =>
        Math.abs(p[axis] - start[axis] - i * pitch) <=
          Math.max(1.5, 0.12 * pitch) &&
        Math.abs(p[1 - axis] - start[1 - axis] - i * stepAcross) <= 1.8,
    )
  );
}
function countPartOverlap(p: InkPart, mask: Uint8Array, width: number) {
  const { x, y, w } = p.rect;
  return p.data.reduce(
    (n, v, i) =>
      n +
      Number(Boolean(v && mask[(y + Math.floor(i / w)) * width + x + (i % w)])),
    0,
  );
}

function isPaperDot(
  p: InkPart,
  tone: Uint8Array,
  paper: Uint8Array,
  width: number,
  height: number,
) {
  const { x, y, w, h } = p.rect;
  if (!smallRoundInk(p) || Math.min(x, y, width - x - w, height - y - h) < 3)
    return false;
  let shell = 0,
    light = 0;
  for (let v = -3; v < h + 3; v++)
    for (let u = -3; u < w + 3; u++) {
      const i = (y + v) * width + x + u;
      if (!paper[i]) return false;
      if (u >= -1 && u <= w && v >= -1 && v <= h) continue;
      if (tone[i] < 228) return false;
      shell++;
      light += Number(tone[i] >= 241);
    }
  return light >= 0.9 * shell;
}

function smallRoundInk(p: InkPart) {
  const { w, h } = p.rect;
  return (
    Math.min(w, h) >= 2 &&
    Math.max(w, h) <= 8 &&
    Math.max(w, h) <= 1.55 * Math.min(w, h) &&
    p.area >= 0.48 * w * h
  );
}
