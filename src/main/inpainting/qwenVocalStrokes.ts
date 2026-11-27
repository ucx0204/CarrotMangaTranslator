import type { PixelRect } from "./maskGeometry";
import type { maskComponents } from "./rasterMasks";

type Part = ReturnType<typeof maskComponents>[number];
type Placement = { rect: PixelRect; bounds: PixelRect };

/** A voiced syllable, small yo, and small tsu form three separate rows. The
 * middle character has three matching crossbars. Their measured faces, together
 * with the terminal triplet, distinguish the ink from an overlapping panel. */
export function contractedKanaFaces(
  parts: Part[],
  field: Placement,
  confirmed: (p: Part) => boolean,
) {
  const { bounds, rect } = field;
  const heads = parts.filter(
    ({ rect: r, area }) =>
      r.h >= 0.46 * rect.h &&
      r.h <= 0.72 * rect.h &&
      r.w >= 0.52 * rect.w &&
      r.w <= 0.99 * rect.w &&
      r.y + bounds.y <= rect.y + 0.14 * rect.h &&
      area > 0.12 * r.w * r.h &&
      area < 0.47 * r.w * r.h,
  );
  if (heads.length !== 1) return;
  const head = heads[0].rect;
  const middle = parts.filter(
    (p) =>
      p.rect.y >= head.y + 0.72 * head.h &&
      p.rect.y <= head.y + 1.16 * head.h &&
      p.rect.h >= 0.11 * rect.h &&
      p.rect.h <= 0.25 * rect.h &&
      p.rect.w >= 0.17 * rect.w &&
      p.rect.w <= 0.45 * rect.w &&
      threeCrossbars(p),
  );
  const accents = parts.filter(
    ({ rect: r }) =>
      r.x >= head.x + 0.72 * head.w &&
      r.x <= head.x + 1.17 * head.w &&
      r.y >= head.y - 0.12 * head.h &&
      r.y <= head.y + 0.26 * head.h &&
      r.h >= 0.36 * head.h &&
      r.h <= 0.69 * head.h &&
      r.w >= 0.16 * r.h &&
      r.w <= 0.66 * r.h,
  );
  if (middle.length !== 1 || accents.length < 1 || accents.length > 2) return;
  const faces = [...heads, ...accents, ...middle];
  if (faces.every(confirmed)) return faces;
}

function threeCrossbars(p: Part) {
  const { w, h } = p.rect;
  return [0.35, 0.5, 0.6].every((fraction) => {
    let starts = 0,
      on = false,
      filled = 0;
    const x = Math.floor(w * fraction);
    for (let y = 0; y < h; y++) {
      const next = Boolean(p.data[y * w + x]);
      if (next && !on) starts++;
      if (next) filled++;
      on = next;
    }
    return starts === 3 && filled >= 0.21 * h && filled <= 0.66 * h;
  });
}

/** Identify a kana followed by an elongated vowel and the small terminal tsu.
 * The parallel pen of a balloon enters at a different height. */
export function vocalStrokeParts(parts: Part[], { rect, bounds }: Placement) {
  const first = parts.filter(
    ({ rect: r, area }) =>
      r.y + bounds.y - rect.y < 0.19 * rect.h &&
      r.h >= 0.24 * rect.h &&
      r.h <= 0.51 * rect.h &&
      r.w > 0.4 * rect.w &&
      area >= 0.19 * r.w * r.h,
  );
  if (first.length !== 1) return;
  const head = first[0];
  const ends = head.rect.y + head.rect.h;
  const long = parts.filter(
    ({ rect: r, area }) =>
      Math.abs(r.y - ends) < 0.09 * rect.h &&
      r.h > 0.23 * rect.h &&
      r.h < 0.53 * rect.h &&
      r.h > 1.95 * r.w &&
      area > 1.9 * r.h,
  );
  if (long.length !== 1) return;
  const last = terminalKana(parts, long[0], { rect, bounds });
  if (last) return [head, long[0], ...last];
}

function terminalKana(parts: Part[], dash: Part, { bounds, rect }: Placement) {
  const box = dash.rect;
  const tip = box.x + dash.data.subarray(-box.w).indexOf(1);
  const end = box.y + box.h;
  const tail = parts.filter(
    ({ rect: r, area }) =>
      r.y >= end - 2 &&
      r.y - end < 0.2 * rect.h &&
      Math.abs(r.x + 0.5 * r.w - tip) < 0.29 * rect.w &&
      Math.min(r.w, r.h) >= Math.max(3, 0.09 * rect.w) &&
      Math.max(r.w, r.h) <= 0.26 * rect.w &&
      area >= 0.29 * r.w * r.h,
  );
  if (!tail.length || tail.length > 3) return;
  const bottom = Math.max(...tail.map((p) => p.rect.y + p.rect.h + bounds.y));
  if (Math.abs(bottom - rect.y - rect.h) < 0.13 * rect.h) return tail;
}

/** A descending pause has three separately printed dots, a main kana above,
 * and a small tsu at its lower end. Their common baseline can cross hatching. */
export function pausedVocalStrokes(
  parts: Part[],
  { rect, bounds }: Placement,
  voiced: boolean,
) {
  const x = (p: Part) => p.rect.x + p.rect.w / 2;
  const y = (p: Part) => p.rect.y + p.rect.h / 2;
  const relative = (p: Part) => (y(p) + bounds.y - rect.y) / rect.h;
  const solid = (p: Part) => p.area / (p.rect.w * p.rect.h);
  const heads = parts.filter(
    (p) =>
      relative(p) < 0.42 &&
      p.rect.h > 0.2 * rect.h &&
      p.rect.h < 0.54 * rect.h &&
      p.rect.w > 0.24 * rect.w &&
      p.rect.w < 0.72 * rect.w &&
      solid(p) > 0.2,
  );
  if (heads.length !== 1) return;
  const head = heads[0];
  const terminal = parts.filter(
    (p) =>
      relative(p) > 0.76 &&
      relative(p) < 0.96 &&
      p.rect.h >= 0.07 * rect.h &&
      p.rect.h < 0.22 * rect.h &&
      p.rect.w >= 0.095 * rect.w &&
      p.rect.w < 0.36 * rect.w &&
      solid(p) > 0.41,
  );
  if (terminal.length !== 1) return;
  const tail = terminal[0],
    dx = x(tail) - x(head),
    dy = y(tail) - y(head);
  const dots = parts
    .filter((p) => {
      const f = (y(p) - y(head)) / dy;
      const { w, h } = p.rect;
      return (
        f > 0.38 &&
        f < 0.86 &&
        Math.abs(x(p) - x(head) - f * dx) < 0.13 * rect.w &&
        Math.min(w, h) >= 3 &&
        Math.max(w, h) < 0.1 * rect.h &&
        Math.min(w, h) >= 0.54 * Math.max(w, h) &&
        solid(p) > 0.5
      );
    })
    .sort((a, b) => y(a) - y(b));
  if (dots.length !== 3) return;
  const [first, middle, last] = dots;
  const pitch = (y(last) - y(first)) / 2;
  if (
    pitch < 0.045 * rect.h ||
    pitch > 0.14 * rect.h ||
    Math.abs(y(middle) - (y(first) + y(last)) / 2) > 2 ||
    Math.abs(x(middle) - (x(first) + x(last)) / 2) > 2.5
  )
    return;
  if (!voiced) return [head, ...dots, tail];
  const accents = parts.filter(
    (p) =>
      p !== head &&
      y(p) < y(head) &&
      x(p) > x(head) &&
      x(p) - x(head) < 0.41 * rect.w &&
      y(head) - y(p) < 0.38 * rect.h &&
      p.rect.h > 0.08 * rect.h &&
      p.rect.h < 0.25 * rect.h &&
      p.rect.h > 1.3 * p.rect.w &&
      solid(p) > 0.41,
  );
  if (
    accents.length === 2 &&
    Math.abs(y(accents[0]) - y(accents[1])) < 0.36 * accents[0].rect.h
  )
    return [head, ...accents, ...dots, tail];
}

export function punctuatedVocalStrokes(
  parts: Part[],
  rect: PixelRect,
  text: string,
) {
  const long = parts.filter(
    ({ rect: r, area }) =>
      r.h >= 0.58 * rect.h &&
      r.h > 1.7 * r.w &&
      area / r.h >= 1.5 &&
      area / r.h <= 0.095 * r.h,
  );
  if (long.length !== 1) return;
  const dash = long[0].rect;
  const end = dash.y + dash.h;
  const stems = parts
    .filter(
      ({ rect: r, area }) =>
        r.h > 0.085 * rect.h &&
        r.h < 0.28 * rect.h &&
        r.h > 2.2 * r.w &&
        r.h < 7 * r.w &&
        Math.abs(r.y - end) <= 0.11 * rect.h &&
        area >= 0.43 * r.w * r.h,
    )
    .sort((a, b) => a.rect.x - b.rect.x);
  if (stems.length !== text.length - 1) return;
  const dots = punctuationDots(stems, parts);
  if (!dots) return;
  const lastRow = long[0].data.subarray((dash.h - 1) * dash.w);
  const tip = dash.x + lastRow.indexOf(1);
  if (!stems.some(({ rect: s }) => Math.abs(s.x + s.w / 2 - tip) <= 0.8 * s.h))
    return;
  return [...long, ...stems, ...dots];
}

function punctuationDots(stems: Part[], parts: Part[]) {
  const dots = new Set<Part>();
  for (const [j, stem] of stems.entries()) {
    const q = stem.rect,
      prev = stems[j - 1]?.rect;
    if (
      prev &&
      (Math.abs(q.h - prev.h) > 0.23 * q.h ||
        Math.abs(q.y - prev.y) > 0.4 * q.h ||
        q.x - prev.x > 2.6 * q.w)
    )
      return;
    const matched = parts.filter(
      ({ rect: p, area }) =>
        p.w >= 0.48 * q.w &&
        p.w <= 1.5 * q.w &&
        p.h >= 0.6 * p.w &&
        p.h <= 1.65 * p.w &&
        p.y >= q.y + q.h &&
        p.y - q.y - q.h <= 0.72 * q.w &&
        Math.abs(p.x + p.w / 2 - q.x - q.w / 2) <= 0.56 * q.w &&
        area >= 0.48 * p.w * p.h,
    );
    if (matched.length !== 1 || dots.has(matched[0])) return;
    dots.add(matched[0]);
  }
  return dots;
}

export const punctuatedDash = /^[ー―—–-]!{2,4}$/u;
const vocalStretch =
  /^[\p{Script=Hiragana}\p{Script=Katakana}]\s*\u3099?ー[っッ]$/u;

export function isSelectedVocalEffect(text: string) {
  return punctuatedDash.test(text) || vocalStretch.test(text);
}

export function isDrawnOutVerticalSound(rect: PixelRect, text: string) {
  return (
    rect.h > 86 &&
    rect.h > 1.55 * rect.w &&
    /^[ぁ-ゖァ-ヺ\p{Script=Han}]{2,7}ー$/u.test(text) &&
    /[ぁ-ゖ\p{Script=Han}]/u.test(text)
  );
}

/** A terminal vertical ellipsis establishes the baseline of short hand-lettered
 * effects. The independent letters above it must form the same number of rows
 * as the original reading before claiming any part of an illustrated balloon. */
export function soundWithTrailingDots(
  parts: Part[],
  { rect, bounds }: Placement,
  letters: number,
) {
  const cy = (p: Part) => p.rect.y + p.rect.h / 2;
  const cx = (p: Part) => p.rect.x + p.rect.w / 2;
  const position = (p: Part) => (cy(p) + bounds.y - rect.y) / rect.h;
  const dots = parts
    .filter(
      (p) =>
        position(p) > 0.68 &&
        p.area >= 6 &&
        p.rect.w <= 0.18 * rect.w &&
        p.rect.h <= 0.1 * rect.h &&
        p.area >= 0.35 * p.rect.w * p.rect.h,
    )
    .sort((a, b) => cy(a) - cy(b));
  if (dots.length !== 3) return;
  const pitch = (cy(dots[2]) - cy(dots[0])) / 2;
  if (
    pitch < 0.04 * rect.h ||
    pitch > 0.14 * rect.h ||
    Math.abs(cy(dots[1]) - cy(dots[0]) - pitch) > 0.32 * pitch ||
    Math.max(...dots.map(cx)) - Math.min(...dots.map(cx)) > 0.36 * pitch
  )
    return;
  const strokes = parts
    .filter(
      (p) =>
        cy(p) < cy(dots[0]) - pitch &&
        p.area >= 24 &&
        p.rect.h < 0.5 * rect.h &&
        p.rect.w < 0.85 * rect.w,
    )
    .sort((a, b) => a.rect.y - b.rect.y);
  const rows: { right: number; left: number; bottom: number; top: number }[] =
    [];
  for (const { rect: p } of strokes) {
    const last = rows.at(-1);
    if (!last || p.y > last.bottom + 0.035 * rect.h)
      rows.push({ top: p.y, bottom: p.y + p.h, left: p.x, right: p.x + p.w });
    else {
      last.left = Math.min(last.left, p.x);
      last.right = Math.max(last.right, p.x + p.w);
      last.bottom = Math.max(last.bottom, p.y + p.h);
    }
  }
  if (
    rows.length === letters &&
    rows.every(
      (r) =>
        r.right - r.left >= 0.28 * rect.w && r.bottom - r.top >= 0.09 * rect.h,
    )
  )
    return [...strokes, ...dots];
}

export function isSeparatedSoundStroke(
  p: Part,
  { bounds, rect }: Placement,
  hasTerminalKana: boolean,
) {
  const y = p.rect.y + bounds.y - rect.y;
  const terminal =
    hasTerminalKana &&
    y >= rect.h * 0.72 &&
    p.rect.h <= 0.18 * rect.h &&
    p.rect.w <= 0.28 * rect.w;
  const area = (terminal ? 0.0046 : 0.007) * rect.w * rect.h;
  return (
    Math.min(p.rect.w, p.rect.h) >=
      Math.max(3, 0.045 * Math.min(rect.w, rect.h)) &&
    p.area >= area &&
    p.rect.w <= 0.74 * rect.w &&
    p.rect.h <= 0.81 * rect.h
  );
}
