import { brushPaper, sharedBrushRadius } from "./qwenSoundRim";
import { measureNativeBrushInk } from "./qwenBrushInk";
import {
  completeHollowSoundMarks,
  completePrintedCrossbars,
  isMaskContourPixel,
} from "./qwenHollowSound";
import { unionWindowMasks } from "./koharuTypographyMask";
import { fillEnclosedMaskHoles } from "../bubbleLayout/bubbleMaskComponents";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import { maskComponents } from "./rasterMasks";

type Stroke = ReturnType<typeof maskComponents>[number];

export function measureDetectedBrush(
  bitmap: Buffer,
  size: { width: number; height: number },
  instance: InpaintingWindowMask,
  broadOnly = false,
) {
  const { w, h } = instance.bounds;
  if (
    Math.min(w, h) < 95 ||
    Math.max(w, h) < 145 ||
    w * h > 600_000 ||
    instance.data.reduce((n, v) => n + Number(!!v), 0) < 5000
  )
    return;
  const bounds = expandRect(instance.bounds, size.width, size.height, 84);
  const brush = measureNativeBrushInk(
    {
      tone: nativeLuminance(bitmap, size.width, bounds),
      owned: projectWindowMask(instance, bounds),
      width: bounds.w,
      height: bounds.h,
    },
    broadOnly,
  );
  if (brush)
    return {
      bounds,
      data: brush.matte,
      compositeOutline: { bounds, data: brush.composite },
      measuredBrush: brush.measuredBrush,
    };
}

function isCompleteInScan(stroke: Stroke, box: PixelRect): boolean {
  const { x, y, w, h } = stroke.rect;
  return (
    x > 1 &&
    y > 1 &&
    x + w < box.w - 1 &&
    y + h < box.h - 1 &&
    Math.min(w, h) >= 12 &&
    stroke.area <= w * h * 0.45
  );
}

/** Recover a cropped white-filled SFX stroke from the original scan. Two
 * complete strokes of the same printing style must belong to the selection. */
export function completeQwenOutlinedLettering(
  bitmap: Buffer,
  size: { width: number; height: number; sourceRect?: PixelRect },
  instance: InpaintingWindowMask,
): InpaintingWindowMask | undefined {
  const short = Math.min(instance.bounds.w, instance.bounds.h);
  if (short < 24) return;
  const box = expandRect(
    instance.bounds,
    size.width,
    size.height,
    Math.min(240, Math.max(48, Math.ceil(1.4 * short))),
  );
  if (box.w * box.h > 1_500_000) return;
  const gray = nativeLuminance(bitmap, size.width, box);
  const distance = distanceToMask(
    projectWindowMask(instance, box),
    box.w,
    box.h,
  );
  const cropped = clippedStroke(gray, box, distance);
  const selected = size.sourceRect;
  const companion =
    selected && completeHollowSoundMarks({ box, selected, gray, distance });
  return cropped && companion
    ? unionWindowMasks(cropped, companion)
    : (cropped ?? companion);
}

function clippedStroke(
  gray: Uint8Array,
  box: PixelRect,
  distance: Float32Array,
) {
  const dark = gray.map((value) => Number(value < 145));
  const anchors: number[] = [];
  const partial: { mask: InpaintingWindowMask; thickness: number }[] = [];
  for (const stroke of maskComponents(dark, box.w, box.h, 100)) {
    const { x, y, w, h } = stroke.rect;
    if (!isCompleteInScan(stroke, box)) continue;
    const shape = measureOutline(stroke, gray, distance, box.w);
    if (!shape) continue;
    if (shape.role === "anchor") anchors.push(shape.thickness);
    else if (shape.role === "partial") {
      partial.push({
        thickness: shape.thickness,
        mask: {
          bounds: { x: x + box.x, y: y + box.y, w, h },
          data: shape.filled,
        },
      });
    }
  }
  // An ambiguous group must not claim a nearby costume detail or panel.
  const eligible = partial.filter(
    ({ thickness }) =>
      anchors.filter((a) => a >= thickness * 0.55 && a <= thickness * 1.8)
        .length >= 2,
  );
  return eligible.length === 1 ? eligible[0].mask : undefined;
}

function measureOutline(
  stroke: Stroke,
  gray: Uint8Array,
  distance: Float32Array,
  stride: number,
) {
  const { x, y, w, h } = stroke.rect;
  const at = (i: number) => (y + Math.floor(i / w)) * stride + x + (i % w);
  let inkHits = 0;
  for (let i = 0; i < stroke.data.length; i++)
    if (stroke.data[i] && distance[at(i)] < 4) inkHits++;
  const inkOwned = inkHits / stroke.area;
  if (inkOwned < 0.27) return;
  const filled = fillEnclosedMaskHoles(stroke.data, w, h);
  const toInk = distanceToMask(stroke.data, w, h);
  let interior = 0,
    white = 0,
    area = 0,
    areaHits = 0,
    distant = 0,
    edge = 0;
  for (let i = 0; i < filled.length; i++) {
    if (!filled[i]) continue;
    area++;
    const p = at(i);
    areaHits += Number(distance[p] < 4);
    distant += Number(distance[p] > 7);
    if (toInk[i] > 1.5) {
      interior++;
      white += Number(gray[p] > 227);
    }
    edge += Number(isMaskContourPixel(filled, w, i));
  }
  if (
    interior < stroke.area * 0.75 ||
    white < interior * 0.965 ||
    area > w * h * 0.49
  )
    return;
  return {
    filled,
    role: outlineRole(inkOwned, areaHits / area, distant),
    thickness: stroke.area / edge,
  };
}

function outlineRole(ink: number, area: number, distant: number) {
  if (ink >= 0.97 && area >= 0.95) return "anchor";
  if (ink <= 0.9 && area >= 0.32 && distant >= 80) return "partial";
}

export function nativeLuminance(
  bitmap: Buffer,
  stride: number,
  box: PixelRect,
) {
  const gray = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    let p = ((y + box.y) * stride + box.x) * 4;
    for (let x = 0; x < box.w; x++, p += 4)
      gray[y * box.w + x] =
        (29 * bitmap[p] + 150 * bitmap[p + 1] + 77 * bitmap[p + 2] + 128) >> 8;
  }
  return gray;
}

type DisplayGlyph = { stroke: Stroke; thickness: number; missing: number };

/** Complete disconnected patches of missing detector ink inside large, solid
 * title lettering. Measure the palette and paper keyline on the printed page. */
export function completeQwenDisplayInk(
  bitmap: Buffer,
  size: { width: number; height: number },
  instance: InpaintingWindowMask,
  source: PixelRect,
): InpaintingWindowMask | undefined {
  if (
    instance.bounds.w * instance.bounds.h < 9_000 ||
    instance.data.reduce((n, v) => n + Number(Boolean(v)), 0) < 4_300
  )
    return;
  const box = expandRect(instance.bounds, size.width, size.height, 18);
  if (box.w * box.h > 1_500_000) return;
  const gray = nativeLuminance(bitmap, size.width, box);
  const owned = projectWindowMask(instance, box);
  const distance = distanceToMask(owned, box.w, box.h);
  const dark = gray.map((v) => Number(v < 142));
  const thickness = distanceToMask(
    dark.map((v) => 1 - v),
    box.w,
    box.h,
  );
  const glyphs: DisplayGlyph[] = [];
  for (const stroke of maskComponents(dark, box.w, box.h, 360)) {
    if (!isDisplayCandidate(stroke.rect, box, source)) continue;
    const glyph = measureDisplayGlyph(stroke, gray, distance, thickness, box.w);
    if (glyph) glyphs.push(glyph);
  }
  const completed = new Uint8Array(owned.length);
  completePrintedCrossbars(
    dark,
    { selected: source, box, gray, distance },
    completed,
  );
  for (const glyph of glyphs) {
    if (
      glyph.missing < 20 ||
      glyphs.filter((g) => isDisplayPeer(glyph, g)).length < 2
    )
      continue;
    const { rect, data } = glyph.stroke;
    data.forEach((set, i) => {
      if (set)
        completed[
          (rect.y + Math.floor(i / rect.w)) * box.w + rect.x + (i % rect.w)
        ] = 1;
    });
  }
  if (completed.some(Boolean))
    return {
      bounds: box,
      data: dilateBinaryMaskDisk(completed, box.w, box.h, 2),
    };
}

function isDisplayCandidate(
  rect: PixelRect,
  box: PixelRect,
  source: PixelRect,
) {
  const { x, y, w, h } = rect;
  const nativeX = box.x + x,
    nativeY = box.y + y;
  return (
    x > 2 &&
    y > 2 &&
    x + w < box.w - 2 &&
    y + h < box.h - 2 &&
    Math.min(w, h) >= 30 &&
    Math.max(w, h) >= 48 &&
    Math.max(w, h) <= 430 &&
    nativeX >= source.x - 3 &&
    nativeY >= source.y - 3 &&
    nativeX + w <= source.x + source.w + 3 &&
    nativeY + h <= source.y + source.h + 3
  );
}

function isDisplayPeer(glyph: DisplayGlyph, other: DisplayGlyph) {
  if (glyph === other) return false;
  const a = glyph.stroke.rect,
    b = other.stroke.rect;
  const spanA = Math.max(a.w, a.h),
    spanB = Math.max(b.w, b.h);
  return (
    other.thickness > 0.4 * glyph.thickness &&
    other.thickness < 2.5 * glyph.thickness &&
    spanB > 0.25 * spanA &&
    spanB < 4 * spanA &&
    Math.min(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) < 1.15 * spanA
  );
}

function measureDisplayGlyph(
  stroke: Stroke,
  gray: Uint8Array,
  dist: Float32Array,
  thick: Float32Array,
  stride: number,
): DisplayGlyph | undefined {
  const { rect, data, area } = stroke;
  const histogram = new Uint32Array(256);
  const widths: number[] = [];
  let covered = 0,
    near = 0,
    missing = 0,
    interior = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const p =
      (rect.y + Math.floor(i / rect.w)) * stride + rect.x + (i % rect.w);
    if (dist[p] === 0) covered++;
    if (dist[p] <= 4.3) near++;
    if (dist[p] > 2.8) missing++;
    widths.push(thick[p]);
    if (thick[p] >= 2.5) {
      interior++;
      histogram[gray[p]]++;
    }
  }
  if (covered < 0.48 * area || near < 0.57 * area || interior < 0.24 * area)
    return;
  if (!isFlatDisplayInk(histogram, interior, near / area)) return;
  if (!hasDisplayKeyline(stroke, gray, stride)) return;
  widths.sort((a, b) => a - b);
  return {
    stroke,
    thickness: widths[Math.floor(0.78 * (widths.length - 1))],
    missing,
  };
}

function isFlatDisplayInk(
  histogram: Uint32Array,
  interior: number,
  near: number,
) {
  const modes = new Uint32Array(256);
  for (let v = 0; v < 142; v++) {
    for (let n = Math.max(0, v - 4); n <= v + 4; n++) modes[v] += histogram[n];
  }
  const dominant = Math.max(...modes);
  if (dominant >= 0.78 * interior) return true;
  if (dominant < 0.46 * interior || near < 0.82) return false;
  const peak = modes.indexOf(dominant);
  modes.fill(0, Math.max(0, peak - 13), peak + 14);
  return dominant + Math.max(...modes) >= 0.94 * interior;
}

function hasDisplayKeyline(
  { rect, data }: Stroke,
  gray: Uint8Array,
  stride: number,
) {
  const w = rect.w + 4,
    h = rect.h + 4,
    inner = new Uint8Array(w * h);
  for (let y = 0; y < rect.h; y++)
    inner.set(data.subarray(y * rect.w, (y + 1) * rect.w), (y + 2) * w + 2);
  const outer = dilateBinaryMaskDisk(inner, w, h, 2);
  let white = 0,
    ring = 0;
  for (let i = 0; i < outer.length; i++) {
    if (!outer[i] || inner[i]) continue;
    ring++;
    const p = (rect.y + Math.floor(i / w) - 2) * stride + rect.x + (i % w) - 2;
    if (gray[p] > 223) white++;
  }
  return white >= 0.62 * ring;
}

/** In a large brush effect, a detector can include the black garment joined
 * to a letter at its scale. Use the original paper around several separated
 * ink strokes to distinguish that garment from the printed characters. */
export function recoverOutlinedBrushEffect(
  bitmap: Buffer,
  size: { width: number; height: number },
  instance: InpaintingWindowMask,
): InpaintingWindowMask | undefined {
  if (
    Math.min(instance.bounds.w, instance.bounds.h) < 90 ||
    instance.bounds.w * instance.bounds.h > 850_000
  )
    return;
  const bounds = expandRect(instance.bounds, size.width, size.height, 23);
  const owned = projectWindowMask(instance, bounds);
  if (owned.reduce((sum, value) => sum + Number(!!value), 0) < 5000) return;
  const tone = nativeLuminance(bitmap, size.width, bounds);
  const dark = tone.map((v) => Number(v < 135));
  const core = new Uint8Array(owned.length);
  const measurements: number[][] = [];
  let anchors = 0;
  for (const part of maskComponents(dark, bounds.w, bounds.h, 45)) {
    const r = part.rect;
    if (
      Math.min(r.x, r.y, bounds.w - r.x - r.w, bounds.h - r.y - r.h) < 4 ||
      Math.max(r.w, r.h) < 7
    )
      continue;
    const box = expandRect(r, bounds.w, bounds.h, 23);
    const local = projectWindowMask({ bounds: r, data: part.data }, box);
    const evidence = brushPaper(part, owned, tone, bounds.w, box, local);
    if (!evidence) continue;
    mergeMaskIntoPage(core, bounds.w, part.rect, part.data);
    anchors++;
    if (evidence.length >= 6) measurements.push(evidence);
  }
  const radius = sharedBrushRadius(anchors, measurements);
  if (!radius) return;
  const distance = distanceToMask(core, bounds.w, bounds.h);
  const figure = dark.reduce(
    (n, v, i) => n + Number(v && owned[i] && distance[i] > 14),
    0,
  );
  if (figure < 800) return;
  return {
    bounds,
    data: Uint8Array.from(distance, (v, i) =>
      Number(v <= radius + 1 && (v < 2.4 || tone[i] > 192)),
    ),
  };
}
