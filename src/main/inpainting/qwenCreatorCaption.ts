import type { PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";

type Glyph = { rect: PixelRect; area: number; data: Uint8Array };
type Print = { bounds: PixelRect; tone: Float32Array; ink: Uint8Array };

/** Broad fallback rectangles around two inline creator names can make the
 * substrate copy a nearby masthead. Mask the measured black lettering and
 * its pale halo while keeping the coloured illustration as a reference. */
export function inlineCreatorCredit(
  bitmap: Buffer,
  page: { width: number; height: number },
  selection: PixelRect,
  reading: string,
) {
  if (
    !/\S.{1,24}(?:原作|作画|イラスト)\s*[:・]\s*\S{2,}/u.test(reading) ||
    selection.w < 5 * selection.h ||
    selection.h < 14 ||
    selection.w * selection.h > 170000
  )
    return;
  const radius = Math.max(5, Math.min(18, Math.round(selection.h * 0.23)));
  const x = Math.max(0, selection.x - radius),
    y = Math.max(0, selection.y - radius);
  const bounds = {
    x,
    y,
    w: Math.min(page.width, selection.x + selection.w + radius) - x,
    h: Math.min(page.height, selection.y + selection.h + radius) - y,
  };
  const ink = measuredCreditInk(bitmap, page.width, selection, bounds);
  if (!ink) return;
  const reach = distanceToMask(ink, bounds.w, bounds.h);
  return { bounds, data: Uint8Array.from(reach, (d) => Number(d <= radius)) };
}

function measuredCreditInk(
  bitmap: Buffer,
  width: number,
  selection: PixelRect,
  bounds: PixelRect,
) {
  const { x, y } = bounds;
  const ink = new Uint8Array(bounds.w * bounds.h),
    columns = new Uint8Array(selection.w);
  let colour = 0,
    dark = 0,
    darkBorder = 0;
  for (let row = 0; row < selection.h; row++)
    for (let col = 0; col < selection.w; col++) {
      const pos = 4 * ((selection.y + row) * width + selection.x + col);
      const max = Math.max(bitmap[pos], bitmap[pos + 1], bitmap[pos + 2]),
        min = Math.min(bitmap[pos], bitmap[pos + 1], bitmap[pos + 2]);
      colour += Number(max - min > 20);
      if (max > 110) continue;
      ink[(selection.y + row - y) * bounds.w + selection.x + col - x] = 1;
      columns[col] = 1;
      dark++;
      darkBorder += Number(
        row === 0 ||
          col === 0 ||
          row === selection.h - 1 ||
          col === selection.w - 1,
      );
    }
  const area = selection.w * selection.h;
  const runs = columns.reduce(
    (sum, v, i) => sum + Number(v === 1 && !columns[i - 1]),
    0,
  );
  if (
    runs < 6 ||
    darkBorder > 4 ||
    dark < 0.045 * area ||
    dark > 0.38 * area ||
    colour < 0.12 * area
  )
    return;
  return ink;
}

export function hasPairedCreatorCredit(text: string) {
  return /^(?:漫画|作画|原作|原案)\s*[:・]?\s*\S{1,24}?\s*(?:原作|作画|漫画|作[:・]?\S)/u.test(
    text.normalize("NFKC").trim(),
  );
}

function hasLightShoulder(glyph: Glyph, { tone, bounds }: Print) {
  const { rect, data } = glyph;
  const samples = [];
  for (let y = -1; y <= rect.h; y++) {
    for (let x = -1; x <= rect.w; x++) {
      const value = tone[(rect.y + y) * bounds.w + rect.x + x];
      if (value < 155) continue;
      let adjacent = false;
      const left = Math.max(0, x - 1),
        right = Math.min(rect.w, x + 2);
      for (
        let row = Math.max(0, y - 1);
        row <= Math.min(rect.h - 1, y + 1);
        row++
      )
        adjacent ||= data
          .subarray(row * rect.w + left, row * rect.w + right)
          .some(Boolean);
      if (adjacent) samples.push(value);
    }
  }
  samples.sort((a, b) => a - b);
  return samples.length >= 4 && samples[samples.length >> 1] >= 214;
}

function smallLetters(glyphs: Glyph[], pageRect: PixelRect, print: Print) {
  const { h } = pageRect,
    { bounds } = print;
  return glyphs
    .filter(
      ({ rect: r, area }) =>
        r.w >= 2 &&
        r.w <= 0.36 * h &&
        r.h >= 3 &&
        r.h <= Math.min(14, 0.22 * h) &&
        area >= 0.15 * r.w * r.h &&
        bounds.y + r.y > pageRect.y + 0.56 * h &&
        bounds.y + r.y + r.h <= pageRect.y + h + 1 &&
        r.x > 0 &&
        r.y > 0 &&
        r.x + r.w < bounds.w &&
        r.y + r.h < bounds.h,
    )
    .filter((glyph) => hasLightShoulder(glyph, print))
    .sort((a, b) => a.rect.x - b.rect.x);
}

function captionGroups(glyphs: Glyph[], height: number, baseline: number) {
  const groups: Glyph[][] = [];
  let right = -Infinity;
  for (const glyph of glyphs) {
    const r = glyph.rect;
    if (Math.abs(r.y + r.h - baseline) > 1) continue;
    if (r.x - right > Math.max(7, 0.16 * height)) groups.push([]);
    groups[groups.length - 1].push(glyph);
    right = Math.max(right, r.x + r.w);
  }
  return groups.filter(
    (line) =>
      line.length >= 6 &&
      Math.max(...line.map(({ rect: r }) => r.x + r.w)) - line[0].rect.x >=
        0.4 * height,
  );
}

function printBelowCreator(line: Glyph[], print: Print, height: number) {
  const { bounds, ink, tone } = print;
  const left = line[0].rect.x,
    right = Math.max(...line.map(({ rect: r }) => r.x + r.w));
  const top = Math.min(...line.map(({ rect: r }) => r.y));
  let anchored = false;
  for (let y = Math.max(0, top - Math.floor(0.64 * height)); y < top - 2; y++)
    anchored ||= ink
      .subarray(y * bounds.w + left, y * bounds.w + right)
      .some(Boolean);
  if (!anchored) return;
  const core = new Uint8Array(tone.length);
  let hits = 0,
    count = 0;
  for (const { rect: r, data } of line) {
    data.forEach((on, i) => {
      if (!on) return;
      const at = (r.y + Math.floor(i / r.w)) * bounds.w + r.x + (i % r.w);
      core[at] = 1;
      count++;
      hits += Number(!!ink[at]);
    });
  }
  const sizes = line.map(({ rect: r }) => r.h).sort((a, b) => a - b);
  const radius = Math.min(9, 1.5 * sizes[sizes.length >> 1]);
  const distance = distanceToMask(core, bounds.w, bounds.h);
  return {
    covered: hits / count,
    data: Uint8Array.from(distance, (d, i) =>
      Number(d <= 2.4 || (d <= radius && tone[i] >= 184)),
    ),
  };
}

/** Small roman credits share a baseline beneath two creator names. A group
 * already covered by the detector corroborates its missed counterpart. */
export function pairedCreatorBaselines(
  print: Print,
  selection: PixelRect,
  glyphs: Glyph[],
) {
  const letters = smallLetters(glyphs, selection, print);
  if (letters.length < 12) return;
  let best: Glyph[][] = [],
    score = 0;
  for (
    let baseline = Math.floor(0.6 * selection.h);
    baseline <= print.bounds.h;
    baseline++
  ) {
    const groups = captionGroups(letters, selection.h, baseline);
    const count = groups.reduce((n, g) => n + g.length, 0);
    if (groups.length >= 2 && count > score) {
      best = groups;
      score = count;
    }
  }
  const lines = best.map((line) => printBelowCreator(line, print, selection.h));
  if (
    lines.some((line) => !line) ||
    !lines.some((line) => line && line.covered > 0.45)
  )
    return;
  const combined = new Uint8Array(print.tone.length);
  for (const line of lines)
    line?.data.forEach((v, i) => {
      if (v) combined[i] = 1;
    });
  return { bounds: print.bounds, data: combined };
}
