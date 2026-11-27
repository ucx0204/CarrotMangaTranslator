import { mergeMaskIntoPage, type PixelRect } from "./maskGeometry";
import { distanceToMask } from "./pageMaskComposite";
import { maskComponents } from "./rasterMasks";

type Colour = [number, number, number];
type Sample = (x: number, y: number) => Colour;
const length = (c: Colour) => Math.hypot(...c);
const gap = (a: Colour, b: Colour) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A strapline or an issue number can share its bounding box with the main
 * logo's glow. Reserve the smaller imprint where repeated glyphs establish
 * its ink; ambiguous peer regions retain their complete rectangle. */
export function mastheadPeerInk(
  bitmap: Buffer,
  pageWidth: number,
  rect: PixelRect,
) {
  const { w, h } = rect;
  if (Math.min(w, h) < 11 || w * h > 240_000) return;
  const pixels: Colour[] = Array.from({ length: w * h }, (_, i) => {
    const pos =
      4 * ((rect.y + Math.floor(i / w)) * pageWidth + rect.x + (i % w));
    return [bitmap[pos], bitmap[pos + 1], bitmap[pos + 2]];
  });
  const neutral = Uint8Array.from(pixels, (c) => Number(Math.max(...c) < 110));
  const dark = peerGlyphFamily(neutral, w, h);
  const chromatic = chromaticPeerLetters(pixels, w, h);
  const ink = dark ?? chromatic;
  if (!ink) return;
  if (chromatic && dark) ink.set(dark.map((value, i) => value | chromatic[i]));
  const pad = Math.max(4, Math.min(9, 0.065 * h));
  const distance = distanceToMask(ink, w, h);
  return {
    bounds: rect,
    data: Uint8Array.from(distance, (value) => Number(value <= pad)),
  };
}

function chromaticPeerLetters(pixels: Colour[], w: number, h: number) {
  const counts = new Uint32Array(32768);
  for (const c of pixels) {
    if (Math.max(...c) - Math.min(...c) > 75)
      counts[(c[0] >> 3) * 1024 + (c[1] >> 3) * 32 + (c[2] >> 3)]++;
  }
  const ranked = Array.from(counts.keys())
    .filter((i) => counts[i] >= 12)
    .sort((a, b) => counts[b] - counts[a]);
  const tried: Colour[] = [];
  for (const bin of ranked) {
    const colour: Colour = [
      (bin >> 10) * 8 + 3,
      ((bin >> 5) & 31) * 8 + 3,
      (bin & 31) * 8 + 3,
    ];
    if (tried.some((c) => gap(c, colour) < 60)) continue;
    const ink = Uint8Array.from(pixels, (c) => Number(gap(c, colour) < 52));
    const glyphs = peerGlyphFamily(ink, w, h);
    if (glyphs) return glyphs;
    tried.push(colour);
    if (tried.length >= 4) break;
  }
}

function peerGlyphFamily(ink: Uint8Array, w: number, h: number) {
  const parts = maskComponents(ink, w, h, 3);
  const anchors = parts.filter(
    ({ rect: b, area }) =>
      b.h >= 0.18 * h &&
      b.h < 0.94 * h &&
      b.w < 0.84 * w &&
      area >= 0.075 * b.w * b.h,
  );
  if (anchors.length < 2) return;
  const left = Math.min(...anchors.map((p) => p.rect.x)),
    right = Math.max(...anchors.map((p) => p.rect.x + p.rect.w));
  const top = Math.min(...anchors.map((p) => p.rect.y)),
    bottom = Math.max(...anchors.map((p) => p.rect.y + p.rect.h));
  if (
    right - left < 0.5 * w ||
    bottom - top < 0.31 * h ||
    bottom - top > 0.96 * h
  )
    return;
  const output = new Uint8Array(ink.length);
  for (const p of parts) {
    const box = p.rect;
    if (
      box.w < 0.84 * w &&
      box.y + box.h > top - 0.16 * h &&
      box.y < bottom + 0.24 * h
    )
      mergeMaskIntoPage(output, w, box, p.data);
  }
  return output;
}

/** A masthead can be behind the figure. Its repeated flat spot ink and the
 * falloff of the white glow on exposed artwork identify the visible print. */
export function measureSpotColourPrint(
  bitmap: Buffer,
  pageWidth: number,
  bounds: PixelRect,
) {
  const { w, h } = bounds;
  if (w < 0.56 * pageWidth || w < 2.8 * h || h < 48) return;
  const sample: Sample = (x, y) => {
    const i = 4 * ((bounds.y + y) * pageWidth + bounds.x + x);
    return [bitmap[i], bitmap[i + 1], bitmap[i + 2]];
  };
  const pigment = flatSpotColour(w, h, sample);
  if (!pigment) return;
  const ink = spotInkComponents(w, h, sample, pigment);
  if (!ink) return;
  const distance = distanceToMask(ink, w, h);
  const allowed = ink.slice();
  const field = { w, h, sample, distance, allowed };
  if (!hasSpotHalo(field)) return;
  for (let i = 0; i < allowed.length; i++)
    if (
      distance[i] <= 2.25 &&
      gap(sample(i % w, Math.floor(i / w)), pigment) < 145
    )
      allowed[i] = 1;
  return { bounds, data: allowed };
}

function hasSpotHalo(field: HaloField) {
  const { w, h, distance } = field;
  let witnessed = 0;
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (distance[i] < 0.9 || distance[i] > 1.5) continue;
      witnessed += Number(measureHaloRay(field, x, y));
    }
  return witnessed >= Math.max(50, 0.27 * w);
}

export function flatSpotColour(
  w: number,
  h: number,
  sample: Sample,
): Colour | undefined {
  const bins = new Int32Array(w * h).fill(-1);
  const counts = new Uint32Array(32768);
  for (let i = 0; i < bins.length; i++) {
    const c = sample(i % w, Math.floor(i / w)),
      high = Math.max(...c);
    if (high >= 196 && high - Math.min(...c) >= 100)
      bins[i] = ((c[0] >> 3) << 10) + ((c[1] >> 3) << 5) + (c[2] >> 3);
  }
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x,
        k = bins[i];
      if (k >= 0 && [i - 1, i + 1, i - w, i + w].every((j) => bins[j] === k))
        counts[k]++;
    }
  const best = counts.reduce((k, c, i) => (c > counts[k] ? i : k), 0);
  if (counts[best] < Math.max(120, 0.004 * w * h)) return;
  return [
    (best >> 10) * 8 + 3,
    ((best >> 5) & 31) * 8 + 3,
    (best & 31) * 8 + 3,
  ];
}

function spotInkComponents(
  w: number,
  h: number,
  sample: Sample,
  pigment: Colour,
) {
  const seeds = Uint8Array.from({ length: w * h }, (_, i) =>
    Number(gap(sample(i % w, Math.floor(i / w)), pigment) < 25),
  );
  const parts = maskComponents(seeds, w, h, 16);
  const large = parts.filter((p) => p.area >= Math.max(70, 0.001 * w * h));
  if (large.length < 4) return;
  const left = Math.min(...large.map((p) => p.rect.x)),
    right = Math.max(...large.map((p) => p.rect.x + p.rect.w));
  const area = large.reduce((n, p) => n + p.area, 0);
  if (right - left < 0.62 * w || area < 0.035 * w * h || area > 0.35 * w * h)
    return;
  const ink = new Uint8Array(seeds.length);
  for (const { rect, data } of parts)
    data.forEach((v, i) => {
      if (v)
        ink[(rect.y + Math.floor(i / rect.w)) * w + rect.x + (i % rect.w)] = 1;
    });
  return ink;
}

type HaloField = {
  w: number;
  h: number;
  sample: Sample;
  distance: Float32Array;
  allowed: Uint8Array;
};
function measureHaloRay(
  { w, h, sample, distance, allowed }: HaloField,
  x: number,
  y: number,
) {
  const points = outwardRay(w, h, distance, x, y);
  if (!points) return false;
  const i = y * w + x;
  const read = (j: number) => sample(points[j] % w, Math.floor(points[j] / w));
  const far = read(26);
  if (
    Math.min(...far) > 205 ||
    gap(far, read(29)) > 48 ||
    distance[points[21]] < 15
  )
    return false;
  const mix = points.map((_, j) => whiteMixture(read(j), far));
  if (!matchesWhiteGlow(mix)) return false;
  for (let j = 0; j < 23; j++) {
    if (mix[j].alpha > 0.035 && mix[j].error < 44) allowed[points[j]] = 1;
  }
  allowed[i] = 1;
  return true;
}

function outwardRay(
  w: number,
  h: number,
  distance: Float32Array,
  x: number,
  y: number,
) {
  const i = y * w + x,
    gx = distance[i + 2] - distance[i - 2],
    gy = distance[i + 2 * w] - distance[i - 2 * w];
  const mag = Math.hypot(gx, gy);
  if (mag < 1) return;
  const points: number[] = [];
  for (let t = 1; t <= 30; t++) {
    const px = Math.round(x + (t * gx) / mag),
      py = Math.round(y + (t * gy) / mag);
    if (px < 0 || px >= w || py < 0 || py >= h) return;
    points.push(py * w + px);
  }
  return points;
}

function whiteMixture(pixel: Colour, far: Colour) {
  const axis: Colour = [255 - far[0], 255 - far[1], 255 - far[2]];
  const alpha =
    axis.reduce((s, v, i) => s + v * (pixel[i] - far[i]), 0) /
    Math.max(25, length(axis) ** 2);
  const estimated: Colour = [
    far[0] + alpha * axis[0],
    far[1] + alpha * axis[1],
    far[2] + alpha * axis[2],
  ];
  return { alpha, error: gap(pixel, estimated) };
}

function matchesWhiteGlow(mix: ReturnType<typeof whiteMixture>[]) {
  const inset = [2, 4, 6, 8, 11].map((i) => mix[i]);
  if (inset[0].alpha < 0.27 || inset[1].alpha < 0.22 || inset[2].alpha < 0.15)
    return false;
  if (inset[0].alpha - mix[17].alpha < 0.22 || inset.some((p) => p.error > 54))
    return false;
  return (
    inset.filter((p, i) => i > 0 && p.alpha > inset[i - 1].alpha + 0.13)
      .length <= 1
  );
}
