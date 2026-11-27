import { expandRect, type PixelRect } from "./maskGeometry";
import { maskComponents } from "./rasterMasks";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";

/** Two opaque inks surrounded by a neutral drawing. A colour glow is part of
 * the print even where the grayscale layout model sees no letter. */
export function measureDuotoneOverprint(
  bitmap: Buffer,
  page: { width: number; height: number },
  word: PixelRect,
) {
  const area = word.w * word.h;
  if (area < 1200 || area > 220000 || word.h < word.w) return;
  const bounds = expandRect(word, page.width, page.height, 21);
  const { ink, red, gold, rim, neutral } = measurePigments(
    bitmap,
    page.width,
    bounds,
    word,
  );
  if (red < 0.09 * area || gold < 0.1 * area || neutral < 0.62 * rim || !rim)
    return;
  return connectedOverprint(ink, bounds, word, area);
}

function isInside(x: number, y: number, word: PixelRect) {
  return (
    x >= word.x && y >= word.y && x < word.x + word.w && y < word.y + word.h
  );
}

function measurePigments(
  bitmap: Buffer,
  stride: number,
  bounds: PixelRect,
  word: PixelRect,
) {
  const ink = new Uint8Array(bounds.w * bounds.h);
  let red = 0,
    gold = 0,
    rim = 0,
    neutral = 0;
  for (let y = 0; y < bounds.h; y++)
    for (let x = 0; x < bounds.w; x++) {
      const px = bounds.x + x,
        py = bounds.y + y,
        i = (py * stride + px) * 4;
      const b = bitmap[i],
        g = bitmap[i + 1],
        r = bitmap[i + 2];
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (isInside(px, py, word)) {
        red += Number(r - g > 95 && r - b > 80 && b - g > -8);
        gold += Number(g - b > 95 && r - b > 140);
      } else {
        rim++;
        neutral += Number(chroma < 18);
      }
      ink[y * bounds.w + x] = Number(r - Math.min(b, g) > 6);
    }
  return { ink, red, gold, rim, neutral };
}

function connectedOverprint(
  ink: Uint8Array,
  bounds: PixelRect,
  word: PixelRect,
  area: number,
) {
  const owned = new Uint8Array(ink.length);
  let active = 0;
  for (const piece of maskComponents(ink, bounds.w, bounds.h, 1)) {
    if (piece.area < 40) continue;
    let within = 0;
    const { rect: r } = piece;
    for (let i = 0; i < piece.data.length; i++) {
      if (!piece.data[i]) continue;
      const x = bounds.x + r.x + (i % r.w),
        y = bounds.y + r.y + Math.floor(i / r.w);
      if (isInside(x, y, word)) within++;
    }
    if (within < 0.5 * piece.area) continue;
    active += within;
    piece.data.forEach((on, i) => {
      if (on)
        owned[(r.y + Math.floor(i / r.w)) * bounds.w + r.x + (i % r.w)] = 1;
    });
  }
  if (active < 0.35 * area) return;
  return { bounds, data: dilateBinaryMaskDisk(owned, bounds.w, bounds.h, 2) };
}
