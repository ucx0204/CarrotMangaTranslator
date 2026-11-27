import { erodeBinaryMask } from "../bubbleLayout/bubbleDistanceTransform";
import { expandRect, type PixelRect } from "./maskGeometry";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import { maskComponents } from "./rasterMasks";

type EdgeReading = {
  bitmap: Buffer;
  page: { width: number; height: number };
  word: PixelRect;
  owner: InpaintingWindowMask;
  reading: string;
  peers: readonly PixelRect[];
};

function eligibleReading({ reading, word }: EdgeReading) {
  const normalized = reading.normalize("NFKC").trim();
  return (
    normalized.length <= 16 &&
    /^[\p{Script=Hiragana}\p{Script=Katakana}ー!?…・.\s]+$/u.test(normalized) &&
    word.w >= 17 &&
    word.w <= 98 &&
    word.h >= word.w &&
    word.h <= 185
  );
}

function contains(rect: PixelRect, x: number, y: number) {
  return (
    x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h
  );
}

function neutralInk(
  { bitmap, page, word, owner }: EdgeReading,
  bounds: PixelRect,
) {
  const ink = new Uint8Array(bounds.w * bounds.h);
  let dark = 0,
    light = 0,
    missing = 0,
    tinted = 0;
  for (let i = 0; i < ink.length; i++) {
    const x = bounds.x + (i % bounds.w),
      y = bounds.y + Math.floor(i / bounds.w),
      at = 4 * (y * page.width + x);
    const g = bitmap[at + 1],
      spread =
        Math.max(bitmap[at], g, bitmap[at + 2]) -
        Math.min(bitmap[at], g, bitmap[at + 2]);
    ink[i] = Number(g < 150 && spread < 35);
    if (!contains(word, x, y)) continue;
    light += Number(g >= 207);
    tinted += Number(spread > 35);
    if (!ink[i]) continue;
    dark++;
    if (
      !contains(owner.bounds, x, y) ||
      !owner.data[(y - owner.bounds.y) * owner.bounds.w + x - owner.bounds.x]
    )
      missing++;
  }
  if (crossesOwner(light, tinted, dark, missing, word.w * word.h)) return ink;
}

function enclosedPiece(r: PixelRect, view: PixelRect, word: PixelRect) {
  const x = r.x + view.x,
    y = r.y + view.y;
  return (
    Math.min(r.x, r.y, view.w - r.x - r.w, view.h - r.y - r.h) > 1 &&
    r.w <= 1.2 * word.w &&
    r.h <= 1.3 * word.w &&
    x >= word.x - 0.42 * word.w &&
    x + r.w <= word.x + 1.48 * word.w &&
    y >= word.y - 0.63 * word.w &&
    y + r.h <= word.y + word.h + 0.56 * word.w
  );
}

function hasPeer(mask: InpaintingWindowMask, peers: readonly PixelRect[]) {
  return peers.some((r) => {
    const b = mask.bounds,
      right = Math.min(r.x + r.w, b.x + b.w),
      bottom = Math.min(r.y + r.h, b.y + b.h);
    for (let y = Math.max(r.y, b.y); y < bottom; y++)
      for (let x = Math.max(r.x, b.x); x < right; x++)
        if (mask.data[(y - b.y) * b.w + x - b.x]) return true;
    return false;
  });
}

/** Outlined kana can straddle a detected balloon. Require disconnected ink
 * from the reading on both sides of its fresh automatic owner. */
export function measureBalloonEdgeReading(
  input: EdgeReading,
): InpaintingWindowMask | undefined {
  if (!eligibleReading(input)) return;
  const { page, word } = input;
  const view = expandRect(
    word,
    page.width,
    page.height,
    Math.min(46, Math.max(12, Math.round(word.w * 0.66))),
  );
  const ink = neutralInk(input, view);
  if (!ink) return;
  const parts = maskComponents(ink, view.w, view.h, 3).filter((p) =>
    enclosedPiece(p.rect, view, word),
  );
  if (parts.length < 3 || parts.length > 37) return;
  const marks = registeredPieces(input, view, parts);
  if (!marks) return;
  const repair =
    word.h > 1.62 * word.w
      ? { bounds: word, data: new Uint8Array(word.w * word.h).fill(1) }
      : {
          bounds: view,
          data: closeLetterGroups(marks, view),
        };
  if (!hasPeer(repair, input.peers)) return repair;
}

function registeredPieces(
  input: EdgeReading,
  view: PixelRect,
  parts: ReturnType<typeof maskComponents>,
) {
  const { word, owner } = input;
  const exposed = new Uint8Array(view.w * view.h);
  for (let i = 0; i < exposed.length; i++) {
    const x = view.x + (i % view.w),
      y = view.y + Math.floor(i / view.w),
      b = owner.bounds;
    if (contains(b, x, y)) exposed[i] = owner.data[(y - b.y) * b.w + x - b.x];
  }
  const near = dilateBinaryMaskDisk(exposed, view.w, view.h, 7);
  const marks = new Uint8Array(exposed.length);
  let touching = 0;
  let outer = 0,
    inner = 0;
  for (const { rect, data } of parts) {
    for (let i = 0; i < data.length; i++) {
      if (!data[i]) continue;
      const x = rect.x + (i % rect.w),
        y = rect.y + Math.floor(i / rect.w);
      marks[y * view.w + x] = 1;
      touching += Number(near[y * view.w + x] > 0);
      const px = x + view.x,
        py = y + view.y,
        b = input.owner.bounds;
      if (!contains(word, px, py)) continue;
      if (contains(b, px, py) && input.owner.data[(py - b.y) * b.w + px - b.x])
        inner++;
      else outer++;
    }
  }
  if (anchorsReading(word, input.reading, parts.length, outer, inner, touching))
    return marks;
}

function crossesOwner(
  light: number,
  tinted: number,
  dark: number,
  missing: number,
  area: number,
) {
  return (
    light > 0.49 * area &&
    tinted < 0.06 * area &&
    dark > 0.036 * area &&
    missing > 0.22 * dark &&
    (missing < 0.97 * dark || dark > 0.24 * area)
  );
}

function anchorsReading(
  word: PixelRect,
  reading: string,
  pieceCount: number,
  outer: number,
  inner: number,
  touching: number,
) {
  const anchor = Math.max(12, word.w * word.h * 0.008);
  const detached =
    pieceCount >= 5 &&
    reading.trim().length <= 3 &&
    word.h < 1.62 * word.w &&
    touching >= 0.045 * outer &&
    outer > 0.21 * word.w * word.h;
  return outer >= anchor && (inner >= anchor || detached);
}

function closeLetterGroups(marks: Uint8Array, view: PixelRect) {
  const halo = dilateBinaryMaskDisk(marks, view.w, view.h, 8);
  const closed = erodeBinaryMask(
    dilateBinaryMaskDisk(halo, view.w, view.h, 17),
    view.w,
    view.h,
    17,
  );
  // Finite-window erosion treats off-page samples as black. Closing must
  // retain the original dilation even at the last punctuation mark.
  for (let i = 0; i < halo.length; i++) if (halo[i]) closed[i] = 1;
  return closed;
}
