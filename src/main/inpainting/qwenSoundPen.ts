import { maskComponents } from "./rasterMasks";
import type { PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";

type Plate = {
  original: Buffer;
  width: number;
  height: number;
  inkBounds: PixelRect | null;
};

/** An outlined sound at the intersection of white balloon paper and shaded
 * artwork. Reserve a band of visible artwork to check the proposed contour. */
export function soundPaperBoundary(
  { inkBounds: box, original, width, height }: Plate,
  stencil: Uint8Array,
  unlabelled = false,
) {
  if (
    !box ||
    Math.max(width, height) > 512 ||
    Math.min(box.w, box.h) < 16 ||
    Math.max(box.w, box.h) > (unlabelled ? 175 : 112) ||
    Math.min(box.x, box.y, width - box.x - box.w, height - box.y - box.h) < 16
  )
    return;
  if (unlabelled && !repeatingInk(original, stencil, width, box)) return;
  const distance = distanceToMask(stencil, width, height);
  if (!opposedPaperBanks(original, distance, width, box, unlabelled)) return;
  const radius = unlabelled ? 5 : 9;
  return {
    condition: Uint8Array.from(distance, (v) => Number(v <= radius)),
    confirms(prediction: Buffer) {
      let count = 0,
        error = 0,
        missed = 0;
      for (let i = 0; i < distance.length; i++) {
        if (distance[i] < 0.6 * radius || distance[i] >= radius) continue;
        const delta = Math.abs(original[4 * i + 1] - prediction[4 * i + 1]);
        count++;
        error += delta;
        missed += Number(delta > 40);
      }
      return (
        count >= 180 &&
        error < (unlabelled ? 14 : 12) * count &&
        missed < 0.083 * count
      );
    },
  };
}

/** A column of matching two-part knock marks is sometimes segmented without
 * a sound label. Read the large glyph and its detached accent at every pitch. */
function repeatingInk(
  original: Buffer,
  stencil: Uint8Array,
  width: number,
  box: PixelRect,
) {
  if (box.w < 27 || box.w > 70 || box.h < 90 || box.h < 2.1 * box.w)
    return false;
  const ink = Uint8Array.from({ length: box.w * box.h }, (_, j) => {
    const i = (box.y + Math.floor(j / box.w)) * width + box.x + (j % box.w);
    return Number(stencil[i] && original[4 * i + 1] < 105);
  });
  const parts = maskComponents(ink, box.w, box.h, 20);
  const glyphs = parts
    .filter(
      ({ rect: r, area }) =>
        r.h >= 12 &&
        r.w >= 0.8 * r.h &&
        r.w <= 1.45 * r.h &&
        area >= 0.35 * r.w * r.h &&
        area <= 0.68 * r.w * r.h,
    )
    .sort((a, b) => a.rect.y - b.rect.y);
  if (glyphs.length < 4) return false;
  const pitch =
    (glyphs[glyphs.length - 1].rect.y - glyphs[0].rect.y) / (glyphs.length - 1);
  return glyphs.every(
    ({ rect: r, area }, k) =>
      area > 0.68 * glyphs[0].area &&
      area < 1.45 * glyphs[0].area &&
      pitch >= 1.6 * r.h &&
      pitch <= 2.8 * r.h &&
      Math.abs(r.y - glyphs[0].rect.y - k * pitch) < 0.16 * pitch &&
      parts.some(
        ({ rect: accent }) =>
          accent.y >= r.y + r.h &&
          accent.y < r.y + 0.88 * pitch &&
          accent.w > 1.3 * accent.h &&
          accent.w >= 0.4 * r.w &&
          Math.abs(accent.x - r.x) <= 1.1 * r.w,
      ),
  );
}

function opposedPaperBanks(
  original: Buffer,
  distance: Float32Array,
  width: number,
  box: PixelRect,
  repeated: boolean,
) {
  const paper = [0, 0, 0, 0],
    area = [0, 0, 0, 0];
  let shaded = 0,
    count = 0;
  const cx = box.x + (box.w - 1) / 2,
    cy = box.y + (box.h - 1) / 2;
  for (let i = 0; i < distance.length; i++) {
    if (distance[i] < 8 || distance[i] > 16) continue;
    const at = i * 4,
      gray = original[at + 1];
    if (
      Math.max(
        Math.abs(original[at] - gray),
        Math.abs(original[at + 2] - gray),
      ) > 4
    )
      return false;
    const k = Number(i % width > cx) + 2 * Number(Math.floor(i / width) > cy);
    area[k]++;
    paper[k] += Number(gray > 248);
    shaded += Number(gray > 150 && gray < 245);
    count++;
  }
  if (Math.min(...area) < 55 || shaded < 0.25 * count) return false;
  const fractions = paper.map((n, k) => n / area[k]);
  if (repeated)
    return fractions.every((f) => f > 0.3) && fractions.some((f) => f > 0.68);
  return fractions.some((v, k) => v > 0.91 && fractions[3 - k] < 0.22);
}
function perimeter(w: number, h: number) {
  const ring: number[] = [];
  for (let x = 0; x < w; x++) ring.push(x);
  for (let y = 1; y < h; y++) ring.push(y * w + w - 1);
  for (let x = w - 2; x >= 0; x--) ring.push((h - 1) * w + x);
  for (let y = h - 2; y > 0; y--) ring.push(y * w);
  return ring;
}
function penEnds(rim: number[], tone: Uint8Array) {
  const ends = rim.filter(
    (p, k) =>
      tone[p] < 165 && tone[rim[(k + rim.length - 1) % rim.length]] >= 165,
  );
  if (
    ends.length !== 2 ||
    rim.filter((p) => tone[p] > 237).length < rim.length * 0.91
  )
    return;
  return ends;
}
/** A short effect straddling a single ink line on pale paper. Both surviving
 * ends must join the same narrow component in the reconstructed image. */
export function soundPenProof({
  original,
  width,
  height,
  inkBounds: b,
}: Plate) {
  if (
    !b ||
    Math.max(b.w, b.h) > 90 ||
    Math.min(b.x, b.y, width - b.x - b.w, height - b.y - b.h) < 8
  )
    return;
  const x0 = b.x - 7,
    y0 = b.y - 7;
  const w = b.w + 14,
    h = b.h + 14,
    samples = Uint8Array.from(
      { length: w * h },
      (_, i) => original[offset(i) + 1],
    );
  function offset(i: number) {
    return 4 * ((y0 + Math.floor(i / w)) * width + x0 + (i % w));
  }
  const rim = perimeter(w, h),
    ends = penEnds(rim, samples);
  if (!ends) return;
  const span = Math.hypot(
    (ends[0] % w) - (ends[1] % w),
    Math.floor(ends[0] / w) - Math.floor(ends[1] / w),
  );
  if (span < 0.62 * Math.max(w, h)) return;
  return (native: Buffer) => {
    const ink = new Uint8Array(w * h);
    let paper = 0;
    for (let i = 0; i < ink.length; i++) {
      const p = offset(i),
        g = native[p + 1];
      if (Math.max(Math.abs(native[p] - g), Math.abs(native[p + 2] - g)) > 9)
        return false;
      if (
        Math.max(
          Math.abs(original[p] - samples[i]),
          Math.abs(original[p + 2] - samples[i]),
        ) > 3
      )
        return false;
      ink[i] = Number(g < 165);
      paper += Number(g >= 237);
    }
    if (paper < 0.84 * ink.length || !ends.every((i) => ink[i])) return false;
    const parts = maskComponents(ink, w, h, 3);
    if (parts.length !== 1) return false;
    const shape = parts[0];
    return (
      shape.area >= span &&
      shape.area <= 4.3 * span &&
      ends.every((i) => {
        const x = (i % w) - shape.rect.x,
          y = Math.floor(i / w) - shape.rect.y;
        return (
          x >= 0 &&
          y >= 0 &&
          x < shape.rect.w &&
          y < shape.rect.h &&
          !!shape.data[y * shape.rect.w + x]
        );
      })
    );
  };
}
