import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { distanceToMask } from "./pageMaskComposite";
import { maskComponents } from "./rasterMasks";
import {
  isSeparatedSoundStroke,
  punctuatedDash,
  isSelectedVocalEffect,
  isDrawnOutVerticalSound,
  pausedVocalStrokes,
  punctuatedVocalStrokes,
  vocalStrokeParts,
} from "./qwenVocalStrokes";
import { knockoutRings } from "./qwenPrintedPigment";
import { isolatedHollowKana } from "./qwenHollowSound";

type Part = ReturnType<typeof maskComponents>[number];
type Field = { gray: Uint8Array; bounds: PixelRect; rect: PixelRect };

/** A short handwritten sound can lie directly on a sleeve or hair strand.
 * Register only strokes that remain separate from those entering the box. */
export function measureSmallSelectedSound(
  bitmap: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  reading: string,
  typedAsSound = true,
) {
  const text = reading.normalize("NFKC").trim();
  const paused = measurePausedVowel(bitmap, page, rect, text);
  if (paused) return paused;
  if (rect.h > 46 && rect.h > 1.28 * rect.w && isSelectedVocalEffect(text))
    return measureSelectedVowel(bitmap, page, rect, text);
  if (isDrawnOutVerticalSound(rect, text))
    return measureVerticalSound(bitmap, page, rect, text, true);
  if (!typedAsSound) return;
  if (rect.h > 112 && rect.h > 1.28 * rect.w)
    return measureVerticalSound(bitmap, page, rect, text);
  return measureIsolatedSound(bitmap, page, rect, text);
}

function measurePausedVowel(
  bitmap: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  text: string,
) {
  const pause = text
    .normalize("NFD")
    .match(/^[ぁ-ゖァ-ヺ](\u3099)?(?:\.{2,}|⋯)[っッ]$/u);
  if (pause && rect.h >= 55 && rect.h <= 160 && rect.h > 1.2 * rect.w) {
    const bounds = expandRect(rect, page.width, page.height, 12);
    const gray = nativeLuminance(bitmap, page.width, bounds);
    const field = { bounds, gray, rect };
    const parts = pausedVocalStrokes(
      enclosedParts(field, 119, false),
      field,
      Boolean(pause[1]),
    );
    if (parts) return measuredKnockout(field, parts, text);
  }
}

function measureIsolatedSound(
  bitmap: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  text: string,
) {
  if (!/^[\p{Script=Hiragana}\p{Script=Katakana}ー]{1,5}$/u.test(text)) return;
  if (Math.min(rect.w, rect.h) < 17 || Math.max(rect.w, rect.h) > 112) return;
  const bounds = expandRect(rect, page.width, page.height, 9);
  const field = {
    bounds,
    rect,
    gray: nativeLuminance(bitmap, page.width, bounds),
  };
  if (text.length === 1 && Math.max(rect.w, rect.h) < 68) {
    const body = isolatedHollowKana(field.gray, bounds, rect);
    if (body) {
      const distance = distanceToMask(body, bounds.w, bounds.h);
      return {
        bounds,
        data: Uint8Array.from(distance, (d) => Number(d <= 3.4)),
        soundReading: text,
      };
    }
  }
  const ink =
    outlinedSoundStrokes(field) ??
    separateSoundStrokes(field, /[っッ]$/u.test(text)) ??
    outlinedSoundBody(field);
  if (ink) return { bounds, data: ink, soundReading: text };
}

function measureSelectedVowel(
  bitmap: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  text: string,
) {
  return punctuatedDash.test(text)
    ? measurePunctuatedDash(bitmap, page, rect, text)
    : measureVocalStretch(bitmap, page, rect, text);
}

/** A drawn-out vowel may finish in a fan of separate exclamation marks.
 * Their aligned stems and individual dots distinguish the dash from pen lines. */
function measurePunctuatedDash(
  bitmap: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  text: string,
) {
  if (rect.h > 390 || rect.w > 145) return;
  const bounds = expandRect(rect, page.width, page.height, 12);
  const gray = nativeLuminance(bitmap, page.width, bounds);
  const parts = enclosedParts({ bounds, gray, rect }, 145, false);
  const strokes = punctuatedVocalStrokes(parts, rect, text);
  if (strokes) return measuredKnockout({ bounds, rect, gray }, strokes, text);
}

function measuredKnockout(
  { gray, bounds }: Field,
  strokes: Part[],
  text: string,
) {
  const ink = new Uint8Array(gray.length);
  for (const p of strokes) mergeMaskIntoPage(ink, bounds.w, p.rect, p.data);
  const distance = distanceToMask(ink, bounds.w, bounds.h);
  const rings = lowerKnockoutLevels(gray, distance, bounds);
  if (rings[1] < 235 || rings[2] < 238) return;
  const edge = rings.findIndex(
    (v, j) =>
      j >= 3 && j <= 8 && v < 195 && rings[j + 1] < 190 && rings[j + 2] < 190,
  );
  if (edge < 0) return;
  return {
    bounds,
    data: Uint8Array.from(distance, (d) => Number(d <= edge + 1.75)),
    soundReading: text,
    measuredSoundOutline: true,
  };
}

/** A tall vowel, its long stroke and terminal small tsu can straddle a
 * balloon. The original balloon contour often runs alongside the dash. */
function measureVocalStretch(
  source: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  text: string,
) {
  if (rect.h > 240 || rect.w < 22 || rect.w > 125) return;
  const bounds = expandRect(rect, page.width, page.height, 12);
  const field = {
    bounds,
    rect,
    gray: nativeLuminance(source, page.width, bounds),
  };
  const parts = enclosedParts(field, 145, false);
  const strokes = vocalStrokeParts(parts, field);
  if (
    strokes &&
    strokes.slice(0, 2).every((p) => hasWhiteShoulder(p, field.gray, bounds))
  )
    return measuredKnockout(field, strokes, text);
}

/** Large vertical effects often have a white knockout around each separate
 * mark. The layout box may also contain entire rails or foreground objects. */
function measureVerticalSound(
  bitmap: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  text: string,
  fineWriting = false,
) {
  if (
    rect.w < 32 ||
    rect.w > 210 ||
    rect.h > 390 ||
    (!fineWriting && !/^[\p{Script=Katakana}ー]{2,6}(?:\.{2,3})?$/u.test(text))
  )
    return;
  const bounds = expandRect(rect, page.width, page.height, 14);
  const gray = nativeLuminance(bitmap, page.width, bounds);
  const parts = verticalSoundStrokes({ gray, rect, bounds }, fineWriting);
  if (!hasVerticalGlyphBodies(parts, rect, fineWriting)) return;
  const top = Math.min(...parts.map((p) => p.rect.y));
  const bottom = Math.max(...parts.map((p) => p.rect.y + p.rect.h));
  if (bottom - top < 0.78 * rect.h) return;
  const ink = new Uint8Array(gray.length);
  for (const p of parts) mergeMaskIntoPage(ink, bounds.w, p.rect, p.data);
  const distance = distanceToMask(ink, bounds.w, bounds.h);
  const radius = verticalKnockoutRadius(gray, distance, bounds);
  if (!radius) return;
  return {
    bounds,
    data: Uint8Array.from(distance, (v) => Number(v <= radius)),
    soundReading: text,
    measuredSoundOutline: true,
  };
}

function verticalSoundStrokes(
  { gray, rect, bounds }: Field,
  fineWriting: boolean,
) {
  return enclosedParts(
    { gray, rect, bounds },
    fineWriting ? 163 : 90,
    false,
  ).filter(
    (part) =>
      part.area >= (fineWriting ? 5 : 24) &&
      part.rect.w >= (fineWriting ? 2 : 4) &&
      part.rect.h >= (fineWriting ? 2 : 3) &&
      hasWhiteShoulder(part, gray, bounds),
  );
}

function verticalKnockoutRadius(
  gray: Uint8Array,
  distance: Float32Array,
  bounds: PixelRect,
) {
  const rings = lowerKnockoutLevels(gray, distance, bounds);
  if (rings[1] < 232 || rings[2] < 240) return;
  const end = rings.findIndex((_, i) => {
    if (i < 3 || i > 9) return false;
    const levels = rings.slice(i, i + 3);
    return (
      Math.max(...levels) < 205 &&
      Math.max(...levels) - Math.min(...levels) < 20
    );
  });
  if (end < 3 || end > 9) return;
  return end + 1.65;
}

function lowerKnockoutLevels(
  gray: Uint8Array,
  distance: Float32Array,
  bounds: PixelRect,
) {
  return knockoutRings(Float32Array.from(gray), distance, bounds.w, {
    ...bounds,
    x: 0,
    y: 0,
  })
    .slice(1)
    .map(
      (ring) =>
        ring.sort((a, b) => a - b)[Math.floor(0.16 * ring.length)] ?? NaN,
    );
}

function hasWhiteShoulder(part: Part, gray: Uint8Array, bounds: PixelRect) {
  const box = expandRect(part.rect, bounds.w, bounds.h, 5);
  const mask = new Uint8Array(box.w * box.h);
  mergeMaskIntoPage(
    mask,
    box.w,
    { ...part.rect, x: part.rect.x - box.x, y: part.rect.y - box.y },
    part.data,
  );
  const distances = distanceToMask(mask, box.w, box.h);
  let total = 0,
    bright = 0;
  distances.forEach((d, i) => {
    if (d <= 1.6 || d >= 3.6) return;
    const j = (box.y + Math.floor(i / box.w)) * bounds.w + box.x + (i % box.w);
    total++;
    bright += Number(gray[j] > 224);
  });
  return bright > 0.89 * total;
}

export function enclosedParts(
  field: Field,
  threshold: number,
  light: boolean,
  inset = 1,
) {
  const { gray, bounds, rect } = field;
  return maskComponents(
    gray.map((v) => Number(light ? v >= threshold : v < threshold)),
    bounds.w,
    bounds.h,
    3,
  ).filter((p) => {
    const x = p.rect.x + bounds.x - rect.x,
      y = p.rect.y + bounds.y - rect.y;
    return (
      Math.min(x, y, rect.w - x - p.rect.w, rect.h - y - p.rect.h) >= inset
    );
  });
}

export function sameInk(a: Part, b: Part) {
  let shared = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (!a.data[i]) continue;
    const x = (i % a.rect.w) + a.rect.x - b.rect.x,
      y = Math.floor(i / a.rect.w) + a.rect.y - b.rect.y;
    if (x >= 0 && x < b.rect.w && y >= 0 && y < b.rect.h)
      shared += Number(Boolean(b.data[y * b.rect.w + x]));
  }
  return shared;
}

function separateSoundStrokes(field: Field, hasTerminalKana: boolean) {
  const { bounds } = field;
  const eligible = (p: Part) =>
    isSeparatedSoundStroke(p, field, hasTerminalKana);
  // A small terminal tsu can end at the exact last pixel of the OCR box.
  // Require the entire component to stay inside it at both ink thresholds.
  const inset = hasTerminalKana ? 0 : 1;
  const dark = enclosedParts(field, 74, false, inset).filter(eligible);
  if (dark.length < 3 || dark.length > 14) return;
  const soft = enclosedParts(field, 103, false, inset).filter(eligible);
  const strokes = dark.filter((p) =>
    soft.some((q) => q.area < 1.7 * p.area && sameInk(p, q) > 0.85 * p.area),
  );
  if (strokes.length < 3) return;
  const ink = new Uint8Array(bounds.w * bounds.h);
  for (const p of strokes) mergeMaskIntoPage(ink, bounds.w, p.rect, p.data);
  return Uint8Array.from(distanceToMask(ink, bounds.w, bounds.h), (d) =>
    Number(d <= 3.75),
  );
}

function outlinedSoundBody(field: Field) {
  const { gray, bounds, rect } = field;
  if (Math.max(rect.w, rect.h) >= 60) return;
  const eligible = (p: Part) =>
    p.rect.w >= 0.34 * rect.w &&
    p.rect.w <= 0.92 * rect.w &&
    p.rect.h >= 0.35 * rect.h &&
    p.rect.h <= 0.92 * rect.h &&
    p.area >= 0.04 * rect.w * rect.h &&
    p.area <= 0.37 * rect.w * rect.h;
  const body = enclosedParts(field, 186, true).filter(eligible);
  if (body.length !== 1) return;
  const p = body[0];
  const bright = enclosedParts(field, 215, true).filter(eligible);
  if (!bright.some((q) => sameInk(p, q) > 0.48 * p.area)) return;
  const inner = new Uint8Array(gray.length);
  mergeMaskIntoPage(inner, bounds.w, p.rect, p.data);
  return includeDarkRim(inner, field, 3.7, 4.5, 218);
}

/** Independently bounded white strokes can cross a much darker emblem.
 * Only claim a stroke when both its interior and its dark rim persist. */
function outlinedSoundStrokes(field: Field) {
  const { rect, gray, bounds } = field;
  const extent = Math.max(rect.w, rect.h);
  if (extent < 60) return;
  const eligible = (part: Part) =>
    Math.max(part.rect.w, part.rect.h) >= 0.47 * extent &&
    part.area >= 0.012 * rect.w * rect.h &&
    part.area <= 0.16 * rect.w * rect.h;
  const bright = enclosedParts(field, 225, true).filter(eligible);
  const strokes = enclosedParts(field, 200, true).filter(
    (p) =>
      eligible(p) &&
      bright.some((q) => sameInk(p, q) >= 0.51 * p.area) &&
      thinDarkRim(field, p),
  );
  if (strokes.length < 2 || strokes.length > 5) return;
  const inner = new Uint8Array(gray.length);
  for (const p of strokes) mergeMaskIntoPage(inner, bounds.w, p.rect, p.data);
  return includeDarkRim(inner, field, 3.2, 4.9, 195);
}

function thinDarkRim({ gray, bounds }: Field, part: Part) {
  const { rect, data } = part;
  const area = new Uint8Array(gray.length);
  mergeMaskIntoPage(area, bounds.w, rect, data);
  const outside = distanceToMask(area, bounds.w, bounds.h);
  const inside = distanceToMask(
    area.map((v) => 1 - v),
    bounds.w,
    bounds.h,
  );
  let rim = 0,
    dark = 0,
    deep = 0;
  for (let i = 0; i < area.length; i++) {
    if (outside[i] > 1 && outside[i] <= 3.3) {
      rim++;
      dark += Number(gray[i] < 145);
    }
    deep += Number(inside[i] > 3.8);
  }
  return rim > 15 && dark > 0.76 * rim && deep < 0.1 * part.area;
}

function includeDarkRim(
  inner: Uint8Array,
  { bounds, gray }: Field,
  core: number,
  shoulder: number,
  shade: number,
) {
  const distance = distanceToMask(inner, bounds.w, bounds.h);
  const rim = Uint8Array.from(distance, (d, i) =>
    Number(d < core || (d < shoulder && gray[i] < shade)),
  );
  return Uint8Array.from(distanceToMask(rim, bounds.w, bounds.h), (d) =>
    Number(d < 1.5),
  );
}

function hasVerticalGlyphBodies(
  parts: Part[],
  rect: PixelRect,
  fineWriting: boolean,
) {
  if (parts.length < 2 || parts.length > 23) return false;
  const bodies = parts.filter(
    (p) =>
      p.rect.w > (fineWriting ? 0.2 : 0.29) * rect.w &&
      p.rect.h > (fineWriting ? 0.1 : 0.13) * rect.h,
  );
  return bodies.length >= 2 && bodies.length <= 7;
}
