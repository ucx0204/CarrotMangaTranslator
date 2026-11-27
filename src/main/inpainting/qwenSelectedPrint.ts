import {
  measureLargeSoundInk,
  measuredSoundKeyline,
  visibleSoundKeyline,
} from "./qwenHollowSound";
import { measureSelectedCaption } from "./qwenCaptionStock";
import {
  recoverQwenFolio,
  recoverQwenIsolatedMark,
} from "./qwenPrintedKeyline";
import { enclosedParts, measureSmallSelectedSound } from "./qwenSmallSound";
import { contractedKanaFaces } from "./qwenVocalStrokes";
import { measureSelectedSignType } from "./qwenSignType";
import { recoverQwenDisplayMask } from "./qwenUndetectedDisplay";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { nativeLuminance } from "./qwenOutlinedLettering";
import { printMaskGrid } from "./qwenPrintedPigment";
import {
  intersectWindowMask,
  projectWindowMask,
} from "./bubbleLayoutConstraintMask";
import { trimWindowMask, unionWindowMasks } from "./koharuTypographyMask";

/** Measure the selected print on the original when the local detector
 * supplies no instance. Prefer the specific reading and stock evidence. */
export function recoverUndetectedPrint(
  bitmap: Buffer,
  options: Parameters<typeof measureSelectedCaption>[1],
  reading: string,
) {
  const rect = options.sourceRect;
  return (
    measureSelectedSignType(bitmap, options.width, rect, reading) ??
    measureSmallSelectedSound(bitmap, options, rect, reading) ??
    measureSelectedCaption(bitmap, options) ??
    recoverQwenFolio(bitmap, options, rect, reading) ??
    recoverQwenDisplayMask(bitmap, options, rect) ??
    recoverQwenIsolatedMark(bitmap, options, rect)
  );
}

/** The OCR box may include a last handwritten column beyond the detector
 * mask. Complete touching, equally inked letters on that edge of the selection. */
export function completeSelectedCaptionColumn(
  bitmap: Buffer,
  size: { width: number; height: number },
  selection: PixelRect,
  instance: InpaintingWindowMask,
) {
  if (selection.w < 36 || selection.h < 1.15 * selection.w) return;
  const inset = instance.bounds.x - selection.x;
  if (inset < Math.max(5, 0.045 * selection.w) || inset > 0.32 * selection.w)
    return;
  const bounds = expandRect(selection, size.width, size.height, 12);
  const gray = nativeLuminance(bitmap, size.width, bounds);
  const raw = projectWindowMask(instance, bounds);
  const dark = gray.map((v) => Number(v < 146));
  const parts = measureCaptionStrokes(dark, raw, bounds, selection);
  const peers = parts.filter(
    (p) => p.coverage >= 0.65 && Math.min(p.rect.w, p.rect.h) >= 6,
  );
  if (peers.length < 7) return;
  const middle = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
  const thickness = middle(peers.map((p) => p.thickness));
  const span = middle(peers.map((p) => Math.max(p.rect.w, p.rect.h)));
  if (span < 9 || thickness < 1.4) return;
  const edge = parts.filter((p) => {
    const cx = bounds.x + p.rect.x + p.rect.w / 2;
    return (
      cx < instance.bounds.x + 0.6 * span &&
      p.coverage < 0.62 &&
      Math.abs(p.thickness - thickness) <= Math.max(0.55, 0.24 * thickness) &&
      Math.max(p.rect.w, p.rect.h) <= 1.8 * span &&
      p.area >= 0.68 * span
    );
  });
  const clipped = edge.filter(
    (p) => p.coverage >= 0.08 && Math.min(p.rect.w, p.rect.h) >= 3,
  );
  if (!clipped.length) return;
  const result = new Uint8Array(raw.length);
  let added = false;
  for (const p of edge) {
    const linked = clipped.some((q) => {
      if (q === p) return false;
      const dx = Math.abs(p.rect.x + p.rect.w / 2 - q.rect.x - q.rect.w / 2);
      const gap = Math.max(
        q.rect.y - p.rect.y - p.rect.h,
        p.rect.y - q.rect.y - q.rect.h,
      );
      return dx < 0.48 * span && gap <= 0.45 * span;
    });
    if (!linked) continue;
    mergeMaskIntoPage(result, bounds.w, p.rect, p.data);
    added = true;
  }
  if (added) return trimWindowMask({ bounds, data: result });
}

function measureCaptionStrokes(
  dark: Uint8Array,
  raw: Uint8Array,
  bounds: PixelRect,
  selection: PixelRect,
) {
  const grid = printMaskGrid(bounds.w, bounds.h);
  const depth = grid.distance(dark.map((v) => 1 - v));
  return grid
    .components(dark, 20)
    .filter(({ rect }) => {
      const x = bounds.x + rect.x - selection.x,
        y = bounds.y + rect.y - selection.y;
      return (
        x >= -2 &&
        y >= -2 &&
        x + rect.w <= selection.w + 2 &&
        y + rect.h <= selection.h + 2 &&
        Math.max(rect.w, rect.h) < 0.42 * selection.w
      );
    })
    .map((part) => {
      let hits = 0;
      const widths: number[] = [];
      const { rect } = part;
      part.data.forEach((on, i) => {
        if (!on) return;
        const p =
          (rect.y + Math.floor(i / rect.w)) * bounds.w + rect.x + (i % rect.w);
        hits += Number(!!raw[p]);
        widths.push(depth[p]);
      });
      widths.sort((a, b) => a - b);
      return {
        ...part,
        coverage: hits / part.area,
        thickness: widths[Math.floor(0.85 * widths.length)],
      };
    });
}

/** Large vertical sound lettering can cover hair and clothing. The separate
 * printed strokes have matching white keylines visible against that artwork. */
export function measureLargeOutlinedSound(
  bitmap: Buffer,
  page: { width: number; height: number },
  rect: PixelRect,
  text: string,
) {
  if (!/^[ぁ-ゖァ-ヺー]{2,7}$/u.test(text)) return;
  if (
    rect.w < 72 ||
    rect.h < 155 ||
    rect.h < 1.15 * rect.w ||
    rect.w * rect.h > 220_000
  )
    return;
  const bounds = expandRect(rect, page.width, page.height, 16);
  const gray = nativeLuminance(bitmap, page.width, bounds);
  const local = { ...rect, x: rect.x - bounds.x, y: rect.y - bounds.y };
  const kinds = ["hollow", "solid"] as const;
  for (const kind of kinds) {
    const mask = measureLargeSoundInk(kind, gray, bounds, local, text.length);
    if (!mask) continue;
    const distance = printMaskGrid(bounds.w, bounds.h).distance(mask);
    const radius = measuredSoundKeyline(gray, distance, bounds);
    if (radius) {
      const data = Uint8Array.from(distance, (v) => Number(v <= radius));
      return {
        bounds,
        data,
        compositeOutline: visibleSoundKeyline(gray, bounds, data),
        soundReading: text,
        measuredSoundOutline: true,
      };
    }
  }
}

type Part = ReturnType<typeof enclosedParts>[number];
type Mark = Part & { owned: number };
type Field = { gray: Uint8Array; bounds: PixelRect; rect: PixelRect };

/** A vertical effect may have an incomplete dakuten or a missing last stroke
 * of small tsu. Require the companion strokes in the actual selection and a
 * separate white keyline around each member before extending the mask. */
export function completeKeylinedKana(
  bitmap: Buffer,
  size: { width: number; height: number },
  rect: PixelRect,
  selected: InpaintingWindowMask,
  reading: string,
  constraint?: InpaintingWindowMask | null,
) {
  if (
    !/^[\p{Script=Katakana}]{1,4}ッ$/u.test(reading) ||
    rect.h < 145 ||
    rect.h > 550 ||
    rect.w < 45 ||
    rect.w > 335 ||
    rect.h < 1.23 * rect.w
  )
    return;
  const bounds = expandRect(rect, size.width, size.height, 12);
  const field = {
    bounds,
    rect,
    gray: nativeLuminance(bitmap, size.width, bounds),
  };
  const strokes = enclosedParts(field, 130, false, -2);
  const parts = strokes
    .filter(
      ({ rect: r, area }) =>
        r.h >= 0.052 * rect.h &&
        r.h <= 0.32 * rect.h &&
        r.w >= 4 &&
        r.w <= r.h &&
        area >= 0.16 * r.w * r.h,
    )
    .map((p) => ({ ...p, owned: ownership(p, selected, bounds) }));
  const tail = terminalStroke(field, parts);
  const missing = [tail?.[2]];
  if (reading[0].normalize("NFD").endsWith("\u3099"))
    missing.push(missingAccent(field, parts));
  const additions = missing.filter((p): p is Mark => Boolean(p));
  if (!additions.length) return;
  const supplement = paddedPrintFaces(bounds, additions, 6);
  const word = registeredKanaWord(field, reading, tail, strokes, selected);
  const registered =
    word && constraint
      ? intersectWindowMask(word, unionWindowMasks(constraint, supplement))
      : word;
  return { ...supplement, registered };
}

function registeredKanaWord(
  field: Field,
  reading: string,
  tail: ReturnType<typeof terminalStroke>,
  strokes: Part[],
  selected: InpaintingWindowMask,
) {
  if (!tail || !/^.\u3099ョッ$/u.test(reading.normalize("NFD"))) return;
  const faces = contractedKanaFaces(
    strokes,
    field,
    (p) =>
      ownership(p, selected, field.bounds) >= 0.82 && outlined(field, p, 0),
  );
  if (faces) return paddedPrintFaces(field.bounds, [...faces, ...tail], 7.25);
}

function paddedPrintFaces(bounds: PixelRect, parts: Part[], radius: number) {
  const ink = new Uint8Array(bounds.w * bounds.h);
  for (const p of parts) mergeMaskIntoPage(ink, bounds.w, p.rect, p.data);
  return {
    bounds,
    data: Uint8Array.from(
      printMaskGrid(bounds.w, bounds.h).distance(ink),
      (d) => Number(d <= radius),
    ),
  };
}

function ownership(p: Part, mask: InpaintingWindowMask, bounds: PixelRect) {
  const left = bounds.x + p.rect.x - mask.bounds.x,
    top = bounds.y + p.rect.y - mask.bounds.y;
  let hits = 0;
  p.data.forEach((v, i) => {
    if (!v) return;
    const x = left + (i % p.rect.w),
      y = top + Math.floor(i / p.rect.w);
    if (x >= 0 && x < mask.bounds.w && y >= 0 && y < mask.bounds.h)
      hits += Number(Boolean(mask.data[y * mask.bounds.w + x]));
  });
  return hits / p.area;
}

function outlined({ gray, bounds }: Field, p: Part, minimumInk = 0.08) {
  const view = expandRect(p.rect, bounds.w, bounds.h, 9);
  const core = new Uint8Array(view.w * view.h);
  mergeMaskIntoPage(
    core,
    view.w,
    { ...p.rect, x: p.rect.x - view.x, y: p.rect.y - view.y },
    p.data,
  );
  const distance = printMaskGrid(view.w, view.h).distance(core);
  let ring = 0,
    white = 0,
    far = 0,
    ink = 0;
  for (let i = 0; i < distance.length; i++) {
    const v =
      gray[
        (view.y + Math.floor(i / view.w)) * bounds.w + view.x + (i % view.w)
      ];
    if (distance[i] >= 2 && distance[i] <= 3.6) {
      ring++;
      white += Number(v >= 215);
    }
    if (distance[i] >= 5 && distance[i] <= 8) {
      far++;
      ink += Number(v < 175);
    }
  }
  return ring >= 32 && white / ring >= 0.83 && ink / far >= minimumInk;
}

function missingAccent(field: Field, parts: Mark[]) {
  const { bounds, rect } = field;
  const upper = parts.filter(
    ({ rect: p }) =>
      p.y + bounds.y <= rect.y + 0.14 * rect.h &&
      p.x + bounds.x >= rect.x + 0.36 * rect.w &&
      p.h >= 0.115 * rect.h &&
      p.w <= 0.79 * p.h,
  );
  const targets = upper.filter(
    (b) =>
      b.owned < 0.53 &&
      upper.some(
        (a) =>
          a.owned >= 0.8 && pairedAccent(a.rect, b.rect) && outlined(field, a),
      ),
  );
  if (targets.length === 1 && outlined(field, targets[0])) return targets[0];
}

function pairedAccent(a: PixelRect, b: PixelRect) {
  const gap = b.x - a.x - a.w,
    em = a.h;
  return (
    gap >= 0 &&
    gap <= 0.42 * em &&
    b.h >= 0.78 * em &&
    b.h <= 1.25 * em &&
    Math.abs(a.y - b.y) <= 0.2 * em &&
    Math.abs(a.y + em - b.y - b.h) <= 0.22 * em &&
    b.w >= 0.28 * a.w &&
    b.w <= 1.38 * a.w
  );
}

function terminalStroke(field: Field, parts: Mark[]) {
  const { rect, bounds } = field;
  const low = parts.filter(
    ({ rect: p }) => p.y + bounds.y >= rect.y + 0.66 * rect.h,
  );
  const taps = low.filter(
    ({ rect: p, owned }) =>
      owned >= 0.78 &&
      p.w <= 0.61 * p.h &&
      p.h <= 0.16 * rect.h &&
      p.w >= 0.18 * p.h,
  );
  const pairs = taps.flatMap((a) =>
    taps.filter((b) => pairedTaps(a.rect, b.rect)).map((b) => [a, b]),
  );
  if (pairs.length !== 1) return;
  const [a, b] = pairs[0];
  const targets = low.filter(
    (p) => p.owned < 0.53 && followsTaps(b.rect, p.rect) && risesRight(p),
  );
  if (
    targets.length === 1 &&
    [a, b, targets[0]].every((p) => outlined(field, p))
  )
    return [a, b, targets[0]] as const;
}

function pairedTaps(a: PixelRect, b: PixelRect) {
  const gap = b.x - a.x - a.w;
  return (
    gap >= 0 &&
    gap <= 1.7 * a.w &&
    Math.abs(a.y - b.y) <= 0.25 * a.h &&
    b.h >= 0.73 * a.h &&
    b.h <= 1.31 * a.h &&
    b.w >= 0.62 * a.w &&
    b.w <= 1.55 * a.w
  );
}

function followsTaps(b: PixelRect, t: PixelRect) {
  return (
    t.h >= 1.16 * b.h &&
    t.h <= 2.35 * b.h &&
    t.w >= 0.46 * t.h &&
    t.w <= 1.2 * t.h &&
    t.x >= b.x - 0.8 * b.w &&
    t.x <= b.x + 1.7 * b.w &&
    t.y >= b.y + 0.12 * b.h &&
    t.y <= b.y + 0.9 * b.h
  );
}

function risesRight(p: Part) {
  const { w, h } = p.rect;
  let top = 0,
    bottom = 0,
    nt = 0,
    nb = 0;
  for (let i = 0; i < p.data.length; i++) {
    if (!p.data[i]) continue;
    const row = Math.floor(i / w);
    if (row < 0.27 * h) {
      top += i % w;
      nt++;
    } else if (row >= 0.73 * h) {
      bottom += i % w;
      nb++;
    }
  }
  return top / nt - bottom / nb >= 0.4 * w;
}
