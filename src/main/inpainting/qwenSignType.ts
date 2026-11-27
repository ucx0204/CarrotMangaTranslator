import { nativeLuminance } from "./qwenOutlinedLettering";
import { maskComponents } from "./rasterMasks";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { maskBoundsInRect } from "./imageRaster";
import { distanceToMask } from "./pageMaskComposite";

/** Reverse type on a black sign has two intact banks of stock, and the
 * separate bright letters share a baseline. Its drawn frame may be very close. */
function signLetters(
  source: Buffer,
  width: number,
  rect: PixelRect,
  [minimum, maximum]: readonly [number, number] = [4, 19],
) {
  const { w, h } = rect;
  if (h < 8 || h > 58 || w < 2.25 * h || w > 360) return;
  const gray = nativeLuminance(source, width, rect);
  const bank = [...gray.subarray(0, w), ...gray.subarray(-w)].sort(
    (a, b) => a - b,
  );
  if (bank[Math.floor(0.94 * bank.length)] > 17 || bank[bank.length - 1] > 43)
    return;
  const light = gray.map((v) => Number(v > 73));
  const parts = maskComponents(light, w, h, 3);
  if (parts.length < minimum || parts.length > maximum) return;
  const letters = parts.map((p) => p.rect);
  if (!sameSignBaseline(letters, w, h)) return;
  const distance = distanceToMask(light, w, h);
  const neutralStock = gray.every((level, i) => {
    const offset =
      4 * ((rect.y + Math.floor(i / w)) * width + rect.x + (i % w));
    const b = source[offset],
      g = source[offset + 1],
      r = source[offset + 2];
    return (
      Math.max(b, g, r) - Math.min(b, g, r) <= 12 &&
      (distance[i] <= 2 || level <= 42)
    );
  });
  if (!neutralStock) return;
  return {
    bounds: rect,
    data: Uint8Array.from(distance, (d) => Number(d <= 2)),
  };
}

function sameSignBaseline(letters: PixelRect[], w: number, h: number) {
  const top = Math.min(...letters.map((r) => r.y));
  const base = Math.max(...letters.map((r) => r.y + r.h));
  const em = base - top;
  return (
    em >= 0.48 * h &&
    letters.every(
      (r) =>
        r.h >= 0.72 * em &&
        r.y + r.h >= base - Math.max(1, 0.16 * em) &&
        r.w <= 2.2 * em &&
        r.x >= 1 &&
        r.x + r.w < w &&
        r.y >= 1 &&
        r.y + r.h < h,
    )
  );
}

export function measureSelectedSignType(
  source: Buffer,
  width: number,
  rect: PixelRect,
  text: string,
) {
  const word = text.normalize("NFKC").trim();
  if (/^[A-Z]{4,19}$/u.test(word))
    return signLetters(source, width, rect, [word.length, word.length]);
}

export function restoreSelectedSignType(
  source: Buffer,
  stencil: Uint8Array,
  width: number,
  height: number,
) {
  const core = maskBoundsInRect(stencil, width, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  if (!core) return;
  if (core.h > 65) return restoreNumberedBand(source, stencil, width, core);
  if (core.w > 380 || core.w <= 2 * core.h) return;
  const light = nativeLuminance(source, width, core).map((v, i) =>
    Number(
      v > 73 &&
        stencil[
          (core.y + Math.floor(i / core.w)) * width + core.x + (i % core.w)
        ],
    ),
  );
  const ink = maskBoundsInRect(light, core.w, { ...core, x: 0, y: 0 });
  if (!ink) return;
  const rect = expandRect(
    { ...ink, x: ink.x + core.x, y: ink.y + core.y },
    width,
    height,
    2,
  );
  const measured = signLetters(source, width, rect);
  if (!measured) return restoreSignRows(source, stencil, width, height, core);
  const result = Buffer.from(source);
  for (let i = 0; i < measured.data.length; i++) {
    if (!measured.data[i]) continue;
    const x = rect.x + (i % rect.w),
      y = rect.y + Math.floor(i / rect.w);
    const dest = y * width + x;
    if (!stencil[dest]) {
      if (source[4 * dest + 1] > 45) return;
      continue;
    }
    const bankY = (x + y) % 2 ? rect.y : rect.y + rect.h - 1;
    const origin = 4 * (bankY * width + x);
    source.copy(result, 4 * dest, origin, origin + 3);
  }
  return result;
}

type SignPart = ReturnType<typeof maskComponents>[number] & { hits: number };

/** A large reverse-printed number may protrude beyond both ruled edges of a
 * black label. Read a native cross-section from untouched columns on both sides. */
function restoreNumberedBand(
  source: Buffer,
  stencil: Uint8Array,
  width: number,
  core: PixelRect,
) {
  const { w, h } = core;
  if (h > 145 || w < 1.45 * h || w > 4 * h || w > 390) return;
  const gray = nativeLuminance(source, width, core);
  const pixel = (x: number, y: number) => (core.y + y) * width + core.x + x;
  if (!gray.every((_, i) => Boolean(stencil[pixel(i % w, Math.floor(i / w))])))
    return;
  const band = numberedBandEdges(gray, w, h);
  if (!band) return;
  const digit = protrudingNumber(band, w);
  if (!digit) return;
  const { left, right } = digit;
  const guide = numberedBandColumns(gray, w, band, left, right);
  if (!guide) return;
  const plate = maskComponents(
    gray.map((v) => Number(v < 215)),
    w,
    h,
    w,
  ).find((p) => p.rect.w === w);
  if (!plate) return;
  const ink = new Uint8Array(w * h);
  mergeMaskIntoPage(ink, w, plate.rect, plate.data);
  return paintNumberedBand(
    source,
    core,
    pixel,
    band,
    guide,
    digit,
    distanceToMask(ink, w, h),
  );
}

function paintNumberedBand(
  source: Buffer,
  core: PixelRect,
  pixel: (x: number, y: number) => number,
  band: { top: number; bottom: number; first: number[]; last: number[] },
  guide: { banks: number[]; left: number; right: number },
  digit: { left: number; right: number },
  toPlate: Float32Array,
) {
  const { w, h } = core,
    { top, bottom } = band,
    { left, right } = digit;
  const result = Buffer.from(source);
  for (let y = 0; y < h; y++) {
    const colors = guide.banks
      .map((x) => source[pixel(x, y) * 4 + 1])
      .sort((a, b) => a - b);
    const level = colors[Math.floor(colors.length / 2)];
    const inBand = y >= top && y <= bottom;
    const start = Math.max(0, inBand ? guide.left - 3 : left - 5);
    const end = Math.min(w - 1, inBand ? guide.right + 3 : right + 5);
    for (let x = start; x <= end; x++) {
      // The white opening of a reverse-printed number can cross the
      // antialiased row just outside the two measured black edges.
      if ((y < top - 2 || y > bottom + 2) && toPlate[y * w + x] > 3.5) continue;
      const i = pixel(x, y) * 4;
      if (
        source[i + 3] !== 255 ||
        Math.max(source[i], source[i + 1], source[i + 2]) -
          Math.min(source[i], source[i + 1], source[i + 2]) >
          14
      )
        return;
      result.fill(level, i, i + 3);
    }
  }
  return result;
}

function protrudingNumber(
  band: { top: number; bottom: number; first: number[]; last: number[] },
  w: number,
) {
  const { top, bottom, first, last } = band;
  const protrudes = first.map((a, x) => a < top - 3 || last[x] > bottom + 3);
  const left = protrudes.indexOf(true),
    right = protrudes.lastIndexOf(true);
  if (
    left < 0.19 * w ||
    right > 0.81 * w ||
    right - left < 0.12 * w ||
    right - left > 0.48 * w
  )
    return;
  return { left, right };
}

function numberedBandEdges(gray: Uint8Array, w: number, h: number) {
  const first: number[] = [],
    last: number[] = [];
  const tops = new Uint32Array(h),
    bottoms = new Uint32Array(h);
  for (let x = 0; x < w; x++) {
    let a = 0,
      b = h - 1;
    while (a < h && gray[a * w + x] >= 57) a++;
    while (b >= 0 && gray[b * w + x] >= 57) b--;
    if (b <= a) return;
    first.push(a);
    last.push(b);
    tops[a]++;
    bottoms[b]++;
  }
  const top = tops.indexOf(Math.max(...tops)),
    bottom = bottoms.indexOf(Math.max(...bottoms));
  if (
    top < 5 ||
    bottom >= h - 5 ||
    bottom - top < 0.35 * h ||
    bottom - top > 0.81 * h
  )
    return;
  const stable = first.filter(
    (v, x) => Math.abs(v - top) <= 1 && Math.abs(last[x] - bottom) <= 1,
  );
  if (stable.length >= 0.53 * w) return { top, bottom, first, last };
}

function numberedBandColumns(
  gray: Uint8Array,
  w: number,
  band: { top: number; bottom: number; first: number[]; last: number[] },
  left: number,
  right: number,
) {
  const { top, bottom, first, last } = band;
  const banks: number[] = [],
    letters: number[] = [];
  for (let x = 0; x < w; x++) {
    let dark = 0,
      white = 0;
    for (let y = top + 3; y < bottom - 2; y++) {
      const value = gray[y * w + x];
      dark += Number(value < 28);
      white += Number(value > 194);
    }
    if (
      Math.abs(first[x] - top) <= 1 &&
      Math.abs(last[x] - bottom) <= 1 &&
      dark > 0.97 * (bottom - top - 5)
    )
      banks.push(x);
    if (white >= 3) letters.push(x);
  }
  const sided = (cols: number[], span: number) =>
    cols.filter((x) => x < left).length >= span &&
    cols.filter((x) => x > right).length >= span;
  if (
    !sided(banks, 0.045 * w) ||
    !sided(letters, 0.085 * w) ||
    letters.filter((x) => x >= left && x <= right).length < 0.11 * w
  )
    return;
  // Both sides of the number must show the same unprinted stock, including
  // the pale paper above and below. A dark patterned picture has no authority here.
  const samples = banks.flatMap((x) => [
    gray[(top - 4) * w + x],
    gray[(bottom + 4) * w + x],
  ]);
  if (samples.filter((value) => value > 238).length < 0.96 * samples.length)
    return;
  return { banks, left: letters[0], right: letters.at(-1) ?? -1 };
}

/** A narrow italic label can sit between a crest and the main name. Its
 * individual strokes must also be present in the selected native detector
 * output. The crest and horizontal rules have no such support. */
function selectedSignRows(parts: SignPart[], core: PixelRect) {
  const reliable = parts.filter(
    (p) => p.hits >= 0.58 * p.area && p.rect.h >= 7,
  );
  const end = (p: SignPart) => p.rect.y + p.rect.h;
  const rows = reliable.map((a) =>
    reliable.filter(
      (b) =>
        Math.abs(end(a) - end(b)) <= 2 &&
        b.rect.h >= 0.68 * a.rect.h &&
        b.rect.h <= 1.4 * a.rect.h,
    ),
  );
  const row = rows.sort((a, b) => b.length - a.length)[0];
  if (!row || row.length < 4) return;
  const left = Math.min(...row.map((p) => p.rect.x));
  const right = Math.max(...row.map((p) => p.rect.x + p.rect.w));
  if (right - left < 0.65 * core.w) return;
  const em = Math.max(...row.map((p) => p.rect.h));
  const top = Math.min(...row.map((p) => p.rect.y));
  const small = parts.filter((p) => !row.includes(p));
  if (
    small.length < 3 ||
    small.filter((p) => p.hits >= 0.24 * p.area).length < 2
  )
    return;
  if (
    !small.every(
      ({ rect: r }) =>
        r.y + r.h <= top &&
        top - r.y <= 1.35 * em &&
        r.h <= 0.85 * em &&
        r.x >= left &&
        r.x + r.w <= right,
    )
  )
    return;
  return [...row, ...small];
}

function selectedSignParts(
  active: Uint8Array,
  stencil: Uint8Array,
  box: PixelRect,
  offset: (i: number) => number,
) {
  const parts: SignPart[] = [];
  for (const part of maskComponents(active, box.w, box.h, 4)) {
    const r = part.rect;
    let hits = 0;
    part.data.forEach((on, i) => {
      if (
        on &&
        stencil[offset((r.y + Math.floor(i / r.w)) * box.w + r.x + (i % r.w))]
      )
        hits++;
    });
    if (!hits) continue;
    if (
      r.x <= 1 ||
      r.y <= 1 ||
      r.x + r.w >= box.w - 1 ||
      r.y + r.h >= box.h - 1
    )
      return;
    parts.push({ ...part, hits });
  }
  return parts;
}

function restoreSignRows(
  source: Buffer,
  stencil: Uint8Array,
  width: number,
  height: number,
  core: PixelRect,
) {
  const box = expandRect(core, width, height, 12);
  const offset = (i: number) =>
    (box.y + Math.floor(i / box.w)) * width + box.x + (i % box.w);
  const gray = nativeLuminance(source, width, box);
  const active = gray.map((v) => Number(v > 73));
  const parts = selectedSignParts(active, stencil, box, offset);
  if (!parts) return;
  const rows = selectedSignRows(parts, core);
  if (!rows) return;
  const selected = new Uint8Array(gray.length);
  for (const p of rows) mergeMaskIntoPage(selected, box.w, p.rect, p.data);
  const distance = distanceToMask(selected, box.w, box.h);
  const foreign = distanceToMask(
    active.map((v, i) => Number(v && !selected[i])),
    box.w,
    box.h,
  );
  const bank = gray.filter(
    (_, i) => distance[i] >= 2.5 && distance[i] < 5.7 && foreign[i] > 2,
  );
  const stock = bank.filter((v) => v <= 24);
  if (bank.length < 80 || stock.length <= 0.9 * bank.length) return;
  const result = Buffer.from(source);
  for (let i = 0; i < gray.length; i++) {
    if (distance[i] > 2.7 || foreign[i] <= 1.2 || foreign[i] < distance[i])
      continue;
    const at = 4 * offset(i);
    if (
      Math.max(source[at], source[at + 1], source[at + 2]) -
        Math.min(source[at], source[at + 1], source[at + 2]) >
      12
    )
      return;
    // Retain the native noise floor on the black stock between the two rules.
    const sample = (i * 41 + Math.floor(i / box.w) * 13) % stock.length;
    result.fill(stock[sample], at, at + 3);
  }
  return result;
}
