import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { maskComponents } from "./rasterMasks";
import type { InpaintingWindowMask } from "./inpaintingEngine";

type Part = ReturnType<typeof maskComponents>[number];
type Stroke = { part: Part; radius: number; solid: number };
type Size = { width: number; height: number };

/** Follow solid, separately printed kana across a panel. The exposed pen
 * behind a long vowel can be thinner than the overlapping printed stroke. */
export function measureHorizontalSound(
  bitmap: Buffer,
  page: Size,
  rect: PixelRect,
  reading: string,
) {
  const text = reading.normalize("NFC").trim();
  if (!/^[ぁ-ゖァ-ヺー]{1,9}(?:…+|[.・]{2,5})?$/u.test(text)) return;
  if (
    rect.h < 29 ||
    rect.h > 145 ||
    rect.w < 52 ||
    rect.w > 560 ||
    rect.w < 1.52 * rect.h
  )
    return;
  const bounds = expandRect(
    rect,
    page.width,
    page.height,
    Math.min(31, Math.max(9, Math.round(0.36 * rect.h))),
  );
  const tone = nativeLuminance(bitmap, page.width, bounds);
  const box = { ...rect, x: rect.x - bounds.x, y: rect.y - bounds.y };
  const parts = maskComponents(
    tone.map((v) => Number(v < 112)),
    bounds.w,
    bounds.h,
    3,
  );
  const dots = /…$|[.・]{2,}$/u.test(text);
  if (rect.w < 98) {
    return dots
      ? narrowScreenedSound(parts, tone, bounds, box, text)
      : undefined;
  }
  const selected = parts
    .filter((p) => onBaseline(p.rect, box, true))
    .map((p) => strokeWidth(p));
  const body = selected.filter((v) => isPrintedStroke(v, box, text));
  if (!solidPrint(body, tone, bounds, box)) return;
  const ink = new Uint8Array(tone.length);
  for (const { part } of [...body, ...terminalDots(body, selected, box, dots)])
    mergeMaskIntoPage(ink, bounds.w, part.rect, part.data);
  const distance = distanceToMask(ink, bounds.w, bounds.h),
    width = Math.min(10, Math.max(4, 0.105 * box.h));
  const support = tone.map((v, i) =>
    Number(distance[i] <= 1.8 || (v > 225 && distance[i] < width)),
  );
  return {
    bounds,
    data: Uint8Array.from(distanceToMask(support, bounds.w, bounds.h), (d) =>
      Number(d < 1.65),
    ),
    soundReading: text,
  };
}

type Dot = { part: Part; x: number; y: number };

function dotNeighbors(a: Dot, dots: Dot[], pitch: number) {
  return dots.filter((b) => {
    const dx = Math.abs(b.x - a.x),
      dy = Math.abs(b.y - a.y);
    return (
      Math.min(dx, dy) <= 0.95 && Math.abs(Math.max(dx, dy) - pitch) < 1.25
    );
  }).length;
}

function screenedEllipsis(points: Dot[], end: number, box: PixelRect) {
  if (points.length < 32) return;
  const small = points.filter((p) => p.part.area <= 9);
  let pitch = 0,
    support = 0;
  for (let step = 6; step <= 15; step++) {
    const count = small.filter((p) => dotNeighbors(p, small, step) >= 2).length;
    if (count > support) {
      pitch = step;
      support = count;
    }
  }
  if (support < Math.max(24, 0.55 * small.length)) return;
  const tail = points
    .filter(
      (p) =>
        p.x > end &&
        p.x < box.x + box.w + 2 &&
        Math.abs(p.y - box.y - 0.52 * box.h) < 0.22 * box.h,
    )
    .sort((a, b) => a.x - b.x);
  let lowest = 5,
    best: Part[] | undefined;
  for (const first of tail) {
    for (const mid of tail) {
      const gap = mid.x - first.x;
      if (gap < 0.4 * pitch || gap > 1.06 * pitch) continue;
      const end = tail
        .filter((p) => Math.abs(p.x - mid.x - gap) < 0.25 * pitch)
        .map((p) => ({
          part: p.part,
          error: ellipsisError([first, mid, p], gap, small, pitch),
        }))
        .sort((a, b) => a.error - b.error)[0];
      if (end && end.error < lowest) {
        lowest = end.error;
        best = [first.part, mid.part, end.part];
      }
    }
  }
  return best;
}

function ellipsisError(dots: Dot[], gap: number, grid: Dot[], pitch: number) {
  const [a, b, c] = dots;
  const spacingError = Math.abs(c.x - b.x - gap);
  if (c.x <= b.x || spacingError > 0.25 * pitch) return Infinity;
  const gridPenalty = dots.reduce(
    (v, p) => v + Math.min(2, dotNeighbors(p, grid, pitch)),
    0,
  );
  return (
    spacingError +
    Math.max(Math.abs(b.y - a.y), Math.abs(c.y - b.y)) +
    0.5 * Math.abs(c.y + a.y - 2 * b.y) +
    1.8 * gridPenalty
  );
}

/** On light dot stock a narrow handwritten stroke may be just two pixels
 * thick. Require an exposed repeating field and three separately aligned
 * punctuation dots before following those strokes. */
function narrowScreenedSound(
  parts: Part[],
  tone: Uint8Array,
  bounds: PixelRect,
  box: PixelRect,
  text: string,
) {
  const body = parts.filter(
    (p) =>
      p.area > 15 &&
      p.area < 0.14 * box.w * box.h &&
      p.rect.x >= box.x &&
      p.rect.y >= box.y &&
      p.rect.x + p.rect.w <= box.x + box.w &&
      p.rect.y + p.rect.h <= box.y + box.h,
  );
  if (body.length < 3 || body.length > 12) return;
  const end = Math.max(...body.map((p) => p.rect.x + p.rect.w));
  if (end < box.x + box.w * 0.46 || end > box.x + box.w * 0.84) return;
  const dots = parts
    .filter((p) => p.rect.h <= 5 && p.rect.w <= 5 && p.area <= 16)
    .map((part) => ({
      part,
      x: part.rect.x + (part.rect.w - 1) / 2,
      y: part.rect.y + (part.rect.h - 1) / 2,
    }));
  const ellipsis = screenedEllipsis(dots, end, box);
  if (!ellipsis) return;
  const ink = new Uint8Array(tone.length);
  for (const p of [...body, ...ellipsis])
    mergeMaskIntoPage(ink, bounds.w, p.rect, p.data);
  return {
    bounds,
    data: Uint8Array.from(distanceToMask(ink, bounds.w, bounds.h), (d) =>
      Number(d <= 3.25),
    ),
    soundReading: text,
    measuredSoundOutline: true,
  };
}

function onBaseline(p: PixelRect, b: PixelRect, dots: boolean) {
  const overlap =
    Math.max(0, Math.min(b.x + b.w, p.x + p.w) - Math.max(p.x, b.x)) *
    Math.max(0, Math.min(b.y + b.h, p.y + p.h) - Math.max(p.y, b.y));
  if (
    Math.min(p.w, p.h) < 2 ||
    p.h > 1.36 * b.h ||
    p.w > Math.max(0.84 * b.w, 1.8 * b.h)
  )
    return false;
  if (overlap >= 0.74 * p.w * p.h) return true;
  return (
    dots &&
    p.x >= b.x + b.w - 14 &&
    p.x <= b.x + b.w + 12 &&
    p.y >= b.y &&
    p.y < b.y + b.h &&
    p.w <= 0.35 * b.h &&
    p.h <= 0.29 * b.h
  );
}

function strokeWidth(part: Part): Stroke {
  const { w, h } = part.rect,
    width = w + 2,
    blank = new Uint8Array(width * (h + 2)).fill(1);
  part.data.forEach((v, i) => {
    if (v) blank[(Math.floor(i / w) + 1) * width + (i % w) + 1] = 0;
  });
  const depth = distanceToMask(blank, width, h + 2);
  let radius = 0,
    thick = 0;
  for (const d of depth) {
    radius = Math.max(radius, d);
    thick += Number(d > 2);
  }
  return { part, radius, solid: thick / part.area };
}

function isPrintedStroke({ part, radius }: Stroke, b: PixelRect, text: string) {
  const p = part.rect;
  if (
    radius >= Math.max(2.7, Math.min(4.15, 0.041 * b.h)) &&
    part.area >= Math.max(28, 0.0011 * b.w * b.h) &&
    part.area > 0.105 * p.w * p.h
  )
    return true;
  if (!/[っッ]$/u.test(text) || p.x < b.x + 0.59 * b.w || radius < 2.5)
    return false;
  return (
    p.h >= 0.12 * b.h &&
    p.h <= 0.48 * b.h &&
    p.w >= 0.11 * b.h &&
    p.w <= 0.47 * b.h &&
    part.area > Math.max(24, 0.004 * b.h * b.h)
  );
}

function solidPrint(
  strokes: Stroke[],
  tone: Uint8Array,
  bounds: PixelRect,
  box: PixelRect,
) {
  if (
    strokes.length < 3 ||
    strokes.reduce((n, s) => n + s.part.area, 0) < 0.041 * box.w * box.h
  )
    return false;
  const fractions = strokes.map((s) => s.solid).sort((a, b) => a - b);
  if (fractions[fractions.length >> 1] < 0.19) return false;
  const tones: number[] = [];
  for (const { part } of strokes)
    collectInteriorTones(part, tone, bounds.w, tones);
  tones.sort((a, b) => a - b);
  return (
    tones.length >= 24 &&
    tones[Math.floor(0.9 * tones.length)] -
      tones[Math.floor(0.1 * tones.length)] <=
      23
  );
}

function collectInteriorTones(
  part: Part,
  tone: Uint8Array,
  stride: number,
  tones: number[],
) {
  const { x, y, w, h } = part.rect;
  for (let row = 1; row < h - 1; row++)
    for (let col = 1; col < w - 1; col++) {
      const i = row * w + col;
      if (
        part.data[i] &&
        part.data[i - 1] &&
        part.data[i + 1] &&
        part.data[i - w] &&
        part.data[i + w]
      )
        tones.push(tone[(y + row) * stride + x + col]);
    }
}

function terminalDots(
  body: Stroke[],
  candidates: Stroke[],
  box: PixelRect,
  dots: boolean,
) {
  const large = body.filter((s) => s.part.area > 0.035 * box.h * box.h);
  if (!large.length) return [];
  let end = Math.max(...large.map(({ part: p }) => p.rect.x + p.rect.w));
  const centers = large
    .map(({ part: p }) => p.rect.y + p.rect.h / 2)
    .sort((a, b) => a - b);
  let y = centers[centers.length >> 1];
  const dotsFound: Stroke[] = [];
  for (const s of candidates
    .slice()
    .sort((a, b) => a.part.rect.x - b.part.rect.x)) {
    const { rect: p, area } = s.part;
    if (!couldBeDot(p, area, box.h)) continue;
    const dy = Math.abs(p.y + p.h / 2 - y),
      dx = p.x - end;
    if (
      dx < -2 ||
      dx > Math.max(23, 0.52 * box.h) ||
      dy > (dotsFound.length ? Math.max(6, 0.16 * box.h) : 0.47 * box.h)
    )
      continue;
    dotsFound.push(s);
    end = p.x + p.w;
    y = p.y + p.h / 2;
  }
  return dotsFound.length >= (dots ? 2 : 3) ? dotsFound : [];
}

function couldBeDot(p: PixelRect, area: number, height: number) {
  return !(
    area >= Math.max(150, 0.043 * height ** 2) ||
    p.w >= 0.45 * height ||
    p.h >= 0.36 * height ||
    area <= 0.31 * p.w * p.h
  );
}

/** A dark tapered stroke on a pale patterned field can extend beyond its
 * detector contour. Require the original dark faces to explain the selection
 * before extending its footprint through their antialiased shoulders. */
export function completeTaperedSound(
  bitmap: Buffer,
  page: Size,
  instance: InpaintingWindowMask,
) {
  const rect = instance.bounds;
  if (rect.h < 100 || rect.h < rect.w || rect.w * rect.h > 180000) return;
  const bounds = expandRect(rect, page.width, page.height, 20);
  const tone = nativeLuminance(bitmap, page.width, bounds);
  const owned = new Uint8Array(tone.length);
  mergeMaskIntoPage(
    owned,
    bounds.w,
    { ...rect, x: rect.x - bounds.x, y: rect.y - bounds.y },
    instance.data,
  );
  const proximity = distanceToMask(owned, bounds.w, bounds.h);
  const core = new Uint8Array(tone.length);
  let strokes = 0,
    registered = 0,
    missingTip = false;
  for (const part of maskComponents(
    tone.map((v) => Number(v < 139)),
    bounds.w,
    bounds.h,
    12,
  )) {
    const measured = taperedFace(part, bounds.w, tone, owned, proximity);
    if (!measured) continue;
    const { overlap, end } = measured;
    strokes++;
    registered += overlap;
    missingTip ||= end > 4;
    mergeMaskIntoPage(core, bounds.w, part.rect, part.data);
  }
  const total = owned.reduce((n, v, i) => n + Number(!!v && tone[i] < 139), 0);
  if (!missingTip || strokes < 4 || strokes > 25 || registered < 0.985 * total)
    return;
  const distance = distanceToMask(core, bounds.w, bounds.h);
  if (!hasPalePattern(tone, distance)) return;
  return { bounds, data: Uint8Array.from(distance, (d) => Number(d <= 7)) };
}

function hasPalePattern(tone: Uint8Array, distance: Float32Array) {
  let bank = 0,
    pale = 0,
    screened = 0;
  for (let i = 0; i < tone.length; i++) {
    if (distance[i] < 7 || distance[i] > 21) continue;
    bank++;
    pale += Number(tone[i] >= 178);
    screened += Number(tone[i] >= 178 && tone[i] < 237);
  }
  return pale >= 0.966 * bank && screened >= 0.12 * bank;
}

function taperedFace(
  part: Part,
  stride: number,
  tone: Uint8Array,
  owned: Uint8Array,
  proximity: Float32Array,
) {
  if (part.area > 2700 || Math.max(part.rect.w, part.rect.h) > 160) return;
  let overlap = 0,
    black = 0,
    end = 0;
  part.data.forEach((v, i) => {
    if (!v) return;
    const p =
      (part.rect.y + Math.floor(i / part.rect.w)) * stride +
      part.rect.x +
      (i % part.rect.w);
    overlap += Number(owned[p] !== 0);
    black += Number(tone[p] < 79);
    end = Math.max(end, proximity[p]);
  });
  if (overlap < 0.76 * part.area || black < 0.66 * part.area || end > 18)
    return;
  return { overlap, end };
}
