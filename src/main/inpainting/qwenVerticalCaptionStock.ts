import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { PixelRect } from "./maskGeometry";
import { trimWindowMask } from "./koharuTypographyMask";
import { distanceToMask } from "./pageMaskComposite";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { maskComponents } from "./rasterMasks";

type Span = { start: number; end: number };
type Strip = PixelRect & { selected: boolean };
type Field = { gray: Uint8Array; marked: Uint8Array; bounds: PixelRect };

function spans(length: number, test: (index: number) => boolean) {
  const runs: Span[] = [];
  let start = -1;
  for (let i = 0; i <= length; i++) {
    if (i < length && test(i)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push({ start, end: i });
      start = -1;
    }
  }
  return runs;
}

/** Reversed vertical captions have uninterrupted dark rails on both edges.
 * Verify multiple matching strips, but clear only the selected lettering. */
export function measureVerticalCaptions(
  bitmap: Buffer,
  size: { width: number; height: number },
  selected: PixelRect,
  instance: InpaintingWindowMask,
  bounds: PixelRect,
) {
  if (
    selected.h < 95 ||
    selected.w < 9 ||
    selected.w > 350 ||
    selected.h < 1.2 * selected.w ||
    selected.h > 1600
  )
    return;
  const field = {
    bounds,
    gray: nativeLuminance(bitmap, size.width, bounds),
    marked: projectWindowMask(instance, bounds),
  };
  const top = selected.y - bounds.y + Math.floor(selected.h / 5);
  const end = selected.y - bounds.y + selected.h - Math.floor(selected.h / 5);
  const darkColumns = Uint8Array.from({ length: bounds.w }, (_, x) => {
    let dark = 0;
    for (let y = top; y < end; y++)
      dark += Number(field.gray[y * bounds.w + x] < 98);
    return Number(dark > 0.43 * (end - top));
  });
  // Tall stems in several successive characters can coincide at one column.
  // The rectangle itself must still have two full-height dark rails.
  const bands = spans(bounds.w, (x) =>
    Boolean(darkColumns[x] || (darkColumns[x - 1] && darkColumns[x + 1])),
  );
  const strips = bands.flatMap((band) => captionStrip(field, band) ?? []);
  if (!matchingStrips(strips)) return;
  const data = new Uint8Array(field.gray.length),
    levels = new Uint8Array(data.length);
  for (const strip of strips.filter((s) => s.selected)) {
    if (!neutralCaption(bitmap, size.width, bounds, strip)) return;
    if (!restoreStrip(field, strip, data, levels)) return;
  }
  const stock = levels.filter((_, i) => Boolean(data[i])).sort();
  if (stock.length)
    return { bounds, data, levels, level: stock[stock.length >> 1] };
}

function matchingStrips(strips: Strip[]) {
  if (strips.length < 2 || strips.length > 5 || !strips.some((s) => s.selected))
    return false;
  const widths = strips.map((s) => s.w).sort((a, b) => a - b);
  const width = widths[widths.length >> 1],
    starts = strips.map((s) => s.y);
  return !(
    widths[widths.length - 1] - widths[0] > 0.2 * width ||
    Math.max(...starts) - Math.min(...starts) > 2 ||
    strips.some((s, i) => i > 0 && s.x - strips[i - 1].x > 2 * width)
  );
}
function neutralCaption(
  bitmap: Buffer,
  width: number,
  bounds: PixelRect,
  strip: Strip,
) {
  for (let y = strip.y + 2; y < strip.y + strip.h - 2; y++)
    for (let x = strip.x + 2; x < strip.x + strip.w - 2; x++) {
      const p = 4 * ((bounds.y + y) * width + bounds.x + x);
      if (
        bitmap[p + 3] !== 255 ||
        Math.max(bitmap[p], bitmap[p + 1], bitmap[p + 2]) -
          Math.min(bitmap[p], bitmap[p + 1], bitmap[p + 2]) >
          6
      )
        return false;
    }
  return true;
}
function captionStrip(
  field: Field,
  { start: x, end }: Span,
): Strip | undefined {
  const {
      gray,
      bounds: { w: stride, h: height },
    } = field,
    w = end - x;
  if (w < 13 || w > 67 || x < 3 || end + 3 >= stride) return;
  const rails = spans(height, (y) => {
    const i = y * stride + x,
      j = y * stride + end;
    return (
      Math.max(
        gray[i + 1] + gray[i + 2] + gray[i + 3],
        gray[j - 4] + gray[j - 3] + gray[j - 2],
      ) < 132
    );
  });
  for (const { start: y, end: bottom } of rails) {
    const h = bottom - y;
    if (h < 4.25 * w || y < 2 || bottom >= height - 1) continue;
    const candidate = measureStripLetters(field, { x, y, w, h });
    if (candidate) return candidate;
  }
}

function measureStripLetters(field: Field, { x, y, w, h }: PixelRect) {
  const {
    gray,
    marked,
    bounds: { w: stride },
  } = field;
  let left = 0,
    right = 0,
    owned = 0,
    bright = 0;
  const iw = w - 6,
    ih = h - 4,
    ink = new Uint8Array(iw * ih);
  for (let v = 0; v < ih; v++) {
    const p = (y + v + 2) * stride + x;
    left += Number(gray[p - 3] + gray[p - 2] > 108);
    right += Number(gray[p + w + 1] + gray[p + w + 2] > 108);
    for (let u = 0; u < iw; u++) {
      const i = p + 3 + u;
      if (gray[i] <= 70) continue;
      ink[v * iw + u] = 1;
      bright++;
      owned += Number(Boolean(marked[i]));
    }
  }
  if (
    Math.min(left, right) < 0.74 * ih ||
    bright < 100 ||
    bright < 0.055 * ink.length ||
    bright > 0.42 * ink.length
  )
    return;
  if (
    maskComponents(ink, iw, ih, 7).filter(
      (p) => p.rect.h >= 2 && p.rect.h <= 1.4 * w,
    ).length < 8
  )
    return;
  return { x, y, w, h, selected: owned >= 0.82 * bright };
}
function restoreStrip(
  field: Field,
  strip: Strip,
  data: Uint8Array,
  levels: Uint8Array,
) {
  const w = strip.w - 4,
    h = strip.h - 4,
    stride = field.bounds.w;
  const index = (i: number) =>
    (strip.y + 2 + Math.floor(i / w)) * stride + strip.x + 2 + (i % w);
  const tone = Uint8Array.from(
    { length: w * h },
    (_, i) => field.gray[index(i)],
  );
  const distance = distanceToMask(
    tone.map((v) => Number(v > 40)),
    w,
    h,
  );
  const bank = tone.filter((_, i) => distance[i] > 4.5).sort();
  if (bank.length < 100 || bank[Math.floor(0.97 * bank.length)] > 22)
    return false;
  // Retain the compression phase and darkness distribution seen on the
  // original rails. Copying a single nearest donor forms visible polygons.
  const phases = Array.from({ length: 16 }, () => [] as number[]);
  const phase = (x: number, y: number) => 4 * (y % 4) + (x % 4);
  for (let i = 0; i < tone.length; i++)
    if (distance[i] > 4.5)
      phases[phase(i % w, Math.floor(i / w))].push(tone[i]);
  for (const values of phases) values.sort((a, b) => a - b);
  for (let i = 0; i < tone.length; i++) {
    if (distance[i] > 4.5) continue;
    const x = i % w,
      y = Math.floor(i / w),
      q = index(i);
    const channel = phases[phase(x, y)],
      observed = channel.length >= 32 ? channel : bank;
    const rank = (((37 * x + 73 * y + ((x * y) % 127)) % 257) + 0.5) / 257;
    data[q] = 1;
    levels[q] = observed[Math.floor(observed.length * (0.06 + 0.87 * rank))];
  }
  return true;
}

export function isVerticalDisplayCaption({ w, h }: PixelRect) {
  return h >= 100 && h <= 650 && w <= 175 && h >= 2.8 * w;
}

/** Return the physical extent of the keyline only where each third of the
 * word is surrounded by independent midtone artwork. */
export function measureSceneCaptionRings(
  gray: Uint8Array,
  mask: Uint8Array,
  bounds: PixelRect,
  selected: PixelRect,
) {
  const { w, h } = bounds;
  const core = mask.map((v, i) => Number(v && gray[i] < 90));
  const distance = distanceToMask(core, w, h);
  const { band, paper, banks, midtone, faces } = captionRings(
    gray,
    distance,
    bounds,
    selected,
  );
  if (
    faces.some((n) => n < 45) ||
    banks.some((n, i) => n < 70 || midtone[i] < 0.54 * n) ||
    paper[2] < 0.92 * band[2] ||
    paper[3] < 0.82 * band[3]
  )
    return;
  // Stop at the first ring beyond the white printing. This keeps native
  // cuffs and fine pen lines beside the type in the final composite.
  let edge = 4;
  while (edge < 8 && paper[edge] > 0.17 * band[edge]) edge++;
  if (edge === 8) return;
  return trimWindowMask({
    bounds,
    data: Uint8Array.from(distance, (v) => Number(v <= edge + 0.8)),
  });
}

function captionRings(
  gray: Uint8Array,
  distance: Float32Array,
  bounds: PixelRect,
  selected: PixelRect,
) {
  const w = bounds.w;
  const band = new Uint32Array(13);
  const paper = new Uint32Array(13);
  const banks = [0, 0, 0];
  const midtone = [0, 0, 0];
  const faces = [0, 0, 0];
  for (let i = 0; i < distance.length; i++) {
    const r = Math.floor(distance[i]);
    if (r >= band.length) continue;
    const y = bounds.y + Math.floor(i / w) - selected.y;
    const row = Math.max(0, Math.min(2, Math.floor((3 * y) / selected.h)));
    band[r]++;
    paper[r] += Number(gray[i] >= 225);
    if (!r) faces[row]++;
    if (r >= 8) {
      banks[row]++;
      midtone[row] += Number(gray[i] >= 55 && gray[i] <= 220);
    }
  }
  return { band, paper, banks, midtone, faces };
}
