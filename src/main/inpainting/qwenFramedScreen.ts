import { enclosedParts, sameInk } from "./qwenSmallSound";
import { soundWithTrailingDots } from "./qwenVocalStrokes";
import type { FluxPlanOptions } from "./qwenSelectedPlan";
import { trimWindowMask } from "./koharuTypographyMask";
import {
  projectWindowMask,
  intersectWindowMask,
} from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { maskComponents } from "./rasterMasks";

/** Measure a knockout printed on screened paper inside a straight narration
 * frame. Curved balloons and rules in the underlying drawing retain ownership. */
export function measureQwenFramedScreen(
  bitmap: Buffer,
  size: { width: number; height: number },
  instance: InpaintingWindowMask,
  owner: InpaintingWindowMask,
): InpaintingWindowMask | undefined {
  const rect = owner.bounds;
  if (Math.min(rect.w, rect.h) < 60 || rect.w * rect.h > 990_000) return;
  const area = rect.w * rect.h;
  if (owner.data.reduce((count, p) => count + Number(!!p), 0) < area * 0.93)
    return;
  if (!hasFourRuledEdges(bitmap, size, rect)) return;
  const bounds = expandRect(instance.bounds, size.width, size.height, 32);
  const gray = nativeLuminance(bitmap, size.width, bounds);
  const original = projectWindowMask(instance, bounds);
  const { ink, count } = selectedInk(gray, original, bounds);
  if (count < 4) return;
  const distance = distanceToMask(ink, bounds.w, bounds.h);
  const foreign = gray.map((v, i) => Number(v < 135 && !ink[i]));
  const margin = distanceToMask(foreign, bounds.w, bounds.h);
  const owned = projectWindowMask(owner, bounds);
  const radius = measuredScreenRadius(gray, distance, margin, owned);
  if (!radius) return;
  const data = owned.map((p, i) =>
    Number(p && distance[i] <= radius && margin[i] >= 2.9),
  );
  return { bounds, data };
}

function hasFourRuledEdges(
  bitmap: Buffer,
  size: { width: number; height: number },
  rect: PixelRect,
) {
  const hasRule = (vertical: boolean, edge: number) => {
    const length = vertical ? rect.h : rect.w;
    const start = vertical ? rect.y : rect.x;
    const limit = vertical ? size.width : size.height;
    for (
      let v = Math.max(0, edge - 7);
      v <= Math.min(limit - 1, edge + 7);
      v++
    ) {
      let dark = 0;
      for (let k = start + 3; k < start + length - 3; k++) {
        const i = (vertical ? k * size.width + v : v * size.width + k) * 4;
        dark += Number(Math.max(bitmap[i], bitmap[i + 1], bitmap[i + 2]) < 101);
      }
      if (dark >= 0.86 * (length - 6)) return true;
    }
    return false;
  };
  return (
    hasRule(true, rect.x) &&
    hasRule(true, rect.x + rect.w) &&
    hasRule(false, rect.y) &&
    hasRule(false, rect.y + rect.h)
  );
}

function selectedInk(
  gray: Uint8Array,
  selection: Uint8Array,
  bounds: PixelRect,
) {
  const ink = new Uint8Array(gray.length);
  let count = 0;
  for (const { rect, area, data } of maskComponents(
    gray.map((v) => Number(v < 153)),
    bounds.w,
    bounds.h,
    2,
  )) {
    if (rect.w >= 0.45 * bounds.w || rect.h >= 0.4 * bounds.h) continue;
    let overlap = 0;
    data.forEach((p, i) => {
      if (
        p &&
        selection[
          (rect.y + Math.floor(i / rect.w)) * bounds.w + rect.x + (i % rect.w)
        ]
      )
        overlap++;
    });
    if (overlap <= 0.61 * area) continue;
    mergeMaskIntoPage(ink, bounds.w, rect, data);
    count++;
  }
  return { ink, count };
}

function measuredScreenRadius(
  gray: Uint8Array,
  distance: Float32Array,
  margin: Float32Array,
  owner: Uint8Array,
) {
  const samples = new Uint32Array(27),
    dots = new Uint32Array(27);
  let pale = 0,
    dark = 0,
    stock = 0;
  for (let i = 0; i < gray.length; i++) {
    if (!owner[i] || margin[i] < 2.9) continue;
    const r = Math.round(distance[i]);
    if (r >= 18 && r < 90) {
      stock++;
      pale += Number(gray[i] >= 232);
      dark += Number(gray[i] < 184);
    }
    if (r < 3 || r >= samples.length) continue;
    samples[r]++;
    dots[r] += Number(gray[i] < 235);
  }
  if (stock < 250 || pale < stock * 0.52 || dark > 0.12 * stock) return;
  return knockoutRadius(samples, dots);
}

function knockoutRadius(samples: Uint32Array, dots: Uint32Array) {
  const density = (a: number, b: number) => {
    let result = 0;
    for (let i = a; i < b; i++) result += dots[i] / Math.max(1, samples[i]);
    return result / (b - a);
  };
  const far = density(19, 27);
  if (far < 0.018 || far > 0.4 || density(3, 6) > 0.56 * far) return;
  let cut = 4;
  for (let i = 3; i < samples.length; i++) {
    if (samples[i] >= 100 && dots[i] > 0.66 * far * samples[i]) break;
    cut = i;
  }
  return Math.max(6, Math.min(18, cut + 3));
}

/** Fine antialiasing can fall outside a narrow effect instance that crosses
 * a panel frame. Measure both ends of the frame and the paper on its outer
 * side before copying the corrected native pixels back onto the page. */
export function ruledGutterComposite(
  bitmap: Buffer,
  size: { width: number; height: number },
  instance: InpaintingWindowMask,
) {
  const { bounds: box } = trimWindowMask(instance);
  if (box.w < 13 || box.w > 156 || box.h < 13 || box.h > 141) return instance;
  const bank = Math.min(41, Math.max(17, Math.floor((box.w - 1) / 2)));
  if (box.x < bank + 4 || box.x + box.w + bank + 4 >= size.width)
    return instance;
  const field = sampleGutterField(bitmap, size, box, instance);
  const starts = [box.x - bank - 3, box.x + box.w + 3];
  const span = Math.max(12, Math.floor(bank / 2));
  for (const [edge, sign, opposite] of panelFaces(field, starts, bank)) {
    const rows = Array.from(
      { length: field.bounds.h },
      (_, i) => field.bounds.y + i,
    ).filter((y) => (y - edge) * sign >= 4 && (y - edge) * sign < box.h);
    if (
      rows.length < 9 ||
      ![starts[0] + bank - span, starts[1]].every((start) =>
        whiteBank(rows, start, span, field.level),
      )
    )
      continue;
    const extended = inkOnPaper(field, rows);
    if (extended) {
      completeRuledKnockout(field, extended.data, edge, opposite);
      return extended;
    }
  }
  return instance;
}

function sampleGutterField(
  bitmap: Buffer,
  size: { width: number; height: number },
  box: PixelRect,
  instance: InpaintingWindowMask,
) {
  const bounds = expandRect(box, size.width, size.height, 8);
  const core = projectWindowMask(instance, bounds);
  const ink = new Uint8Array(core.length);
  const level = (x: number, y: number, dark: boolean) => {
    const i = 4 * (y * size.width + x);
    return dark
      ? Math.max(bitmap[i], bitmap[i + 1], bitmap[i + 2])
      : Math.min(bitmap[i], bitmap[i + 1], bitmap[i + 2]);
  };
  const at = (i: number) =>
    [bounds.x + (i % bounds.w), bounds.y + Math.floor(i / bounds.w)] as const;
  for (let i = 0; i < core.length; i++) {
    if (!core[i]) continue;
    const [x, y] = at(i);
    ink[i] = Number(level(x, y, true) < 160);
  }
  const distance = distanceToMask(core, bounds.w, bounds.h);
  const toInk = distanceToMask(ink, bounds.w, bounds.h);
  return { core, distance, toInk, bounds, level };
}

type GutterField = ReturnType<typeof sampleGutterField>;

function* panelFaces(
  { bounds, level }: GutterField,
  starts: number[],
  bank: number,
) {
  const solid = (y: number) =>
    starts.every((start) => {
      let count = 0;
      for (let x = start; x < start + bank; x++)
        count += Number(level(x, y, true) < 65);
      return count >= bank * 0.84;
    });
  const last = bounds.y + bounds.h;
  for (let y = bounds.y; y < last; y++) {
    if (!solid(y)) continue;
    const first = y;
    while (y + 1 < last && solid(y + 1)) y++;
    if (y - first < 1 || y - first > 12) continue;
    yield [y, 1, first] as const;
    yield [first, -1, y] as const;
  }
}

function completeRuledKnockout(
  { bounds, core, distance, level }: GutterField,
  destination: Uint8Array,
  near: number,
  far: number,
) {
  // The same white outline that extends onto paper can interrupt the
  // solid ink of the measured rule on its way across the panel.
  const light = core.map((set, i) =>
    Number(
      !!set &&
        level(
          bounds.x + (i % bounds.w),
          bounds.y + Math.floor(i / bounds.w),
          false,
        ) > 130,
    ),
  );
  const toLight = distanceToMask(light, bounds.w, bounds.h);
  for (let y = Math.min(near, far); y <= Math.max(near, far); y++)
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      const i = (y - bounds.y) * bounds.w + x - bounds.x;
      if (distance[i] <= 2.25 && toLight[i] <= 2.25 && level(x, y, false) > 55)
        destination[i] = 1;
    }
}

function inkOnPaper(
  { core, distance, toInk, bounds, level }: GutterField,
  rows: number[],
) {
  const data = core.slice();
  let exposed = 0,
    white = 0,
    inside = 0,
    dark = 0,
    added = 0;
  for (const row of rows)
    for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
      const i = (row - bounds.y) * bounds.w + x - bounds.x;
      const hi = level(x, row, true),
        lo = level(x, row, false);
      if (distance[i] > 5) {
        exposed++;
        white += Number(lo > 247);
      }
      if (core[i]) {
        inside++;
        dark += Number(hi < 100);
      } else if (hasInkShoulder(distance[i], toInk[i], hi, lo)) {
        data[i] = 1;
        added++;
      }
    }
  const clear = exposed >= 45 && white >= exposed * 0.976;
  const selected = inside >= 60 && dark >= 16;
  if (clear && selected && added) return { bounds, data };
}

function hasInkShoulder(
  distance: number,
  inkDistance: number,
  high: number,
  low: number,
) {
  return (
    distance <= 6.2 && inkDistance <= 6.3 && high < 255 && high - low <= 10
  );
}

function whiteBank(
  rows: number[],
  start: number,
  span: number,
  level: (x: number, y: number, dark: boolean) => number,
) {
  let white = 0,
    bright = 0;
  for (const y of rows)
    for (let x = start; x < start + span; x++) {
      const value = level(x, y, false);
      white += Number(value > 249);
      bright += Number(value >= 254);
    }
  const area = rows.length * span;
  return white >= 0.967 * area && bright >= 0.5 * area;
}

export function framedSoundInk(options: FluxPlanOptions) {
  if (
    options.fallbackConstraint &&
    options.conditionOnTypography &&
    options.bitmap &&
    options.segmentation &&
    options.block.textRole === "sound" &&
    options.block.bubbleLayout?.origin !== "manual"
  ) {
    const isolated = measureFramedSoundWithPause(
      options.bitmap,
      options,
      options.sourceRect,
      options.block.sourceText,
    );
    if (isolated) {
      const owned = intersectWindowMask(isolated, options.fallbackConstraint);
      if (isolated.data.every((v, i) => !v || owned.data[i])) return isolated;
    }
  }
}

export function measureFramedSoundWithPause(
  bitmap: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  reading: string,
) {
  const letters = reading
    .normalize("NFKC")
    .trim()
    .match(
      /^([\p{Script=Hiragana}\p{Script=Katakana}ー]{2,4})(?:\.{3}|⋯)$/u,
    )?.[1];
  if (
    !letters ||
    rect.w < 26 ||
    rect.w > 140 ||
    rect.h < 64 ||
    rect.h > 260 ||
    rect.h < 1.25 * rect.w
  )
    return;
  const bounds = expandRect(rect, page.width, page.height, 14);
  const gray = nativeLuminance(bitmap, page.width, bounds);
  const field = { rect, bounds, gray };
  const parts = enclosedParts(field, 80, false, -4);
  const printed = soundWithTrailingDots(parts, field, [...letters].length);
  if (!printed) return;
  return { bounds, data: antialiasedSoundMask(field, parts, printed) };
}

function antialiasedSoundMask(
  field: { rect: PixelRect; bounds: PixelRect; gray: Uint8Array },
  parts: ReturnType<typeof enclosedParts>,
  printed: ReturnType<typeof enclosedParts>,
) {
  const { bounds, gray } = field;
  const strokes = new Uint8Array(gray.length);
  for (const p of printed) mergeMaskIntoPage(strokes, bounds.w, p.rect, p.data);
  for (const lighter of enclosedParts(field, 175, false, -4)) {
    if (
      printed.some((p) => sameInk(p, lighter) > 0) &&
      !parts.some(
        (p) => p.area >= 8 && !printed.includes(p) && sameInk(p, lighter) > 0,
      )
    )
      mergeMaskIntoPage(strokes, bounds.w, lighter.rect, lighter.data);
  }
  const other = distanceToMask(
    gray.map((value, i) => Number(value < 80 && !strokes[i])),
    bounds.w,
    bounds.h,
  );
  const distance = distanceToMask(strokes, bounds.w, bounds.h);
  return Uint8Array.from(distance, (d, i) =>
    Number(d <= 3.5 && d + 0.5 < other[i]),
  );
}
