import { setImmediate as yieldToMain } from "node:timers/promises";
import type { PixelRect } from "./maskGeometry";
import { printMaskGrid } from "./qwenPrintedPigment";

type Input = {
  inkBounds: PixelRect | null;
  original: Buffer;
  stencil: Uint8Array;
  width: number;
  height: number;
};
type Patch = { tones: number[]; mean: number; deviation: number };

/** Only start the graded-screen solver on a large, narrow piece of print
 * with many exposed tiles of high-contrast monochrome halftone. */
export function couldContainGradedPrint(input: Input) {
  const { inkBounds: box, original, stencil, width, height } = input;
  if (
    !box ||
    Math.min(box.w, box.h) < 100 ||
    Math.max(box.w, box.h) < 1.6 * Math.min(box.w, box.h) ||
    (box.w + 96) * (box.h + 96) > 400000
  )
    return false;
  let available = 0,
    screened = 0;
  for (
    let y = Math.max(0, box.y - 24);
    y < Math.min(height - 8, box.y + box.h + 24);
    y += 8
  )
    for (
      let x = Math.max(0, box.x - 24);
      x < Math.min(width - 8, box.x + box.w + 24);
      x += 8
    ) {
      const tile = exposedTile(original, stencil, width, x, y);
      if (tile === undefined) continue;
      available++;
      screened += Number(tile);
    }
  return available >= 60 && screened >= 0.6 * available;
}

function exposedTile(
  source: Buffer,
  stencil: Uint8Array,
  width: number,
  x: number,
  y: number,
) {
  const quarters = [0, 0, 0, 0];
  let sum = 0,
    squares = 0;
  for (let dy = 0; dy < 8; dy++)
    for (let dx = 0; dx < 8; dx++) {
      const i = (y + dy) * width + x + dx,
        p = 4 * i,
        v = source[p];
      if (stencil[i]) return;
      if (v !== source[p + 1] || v !== source[p + 2] || source[p + 3] !== 255)
        return false;
      sum += v;
      squares += v * v;
      quarters[(dy >> 2) * 2 + (dx >> 2)] += v;
    }
  const mean = sum / 64;
  return (
    mean > 42 &&
    mean < 230 &&
    squares / 64 - mean * mean > 26 * 26 &&
    Math.max(...quarters) - Math.min(...quarters) < 28 * 16
  );
}

function patch(plane: Uint8Array, center: number, offsets: number[]): Patch {
  const tones = offsets.map((offset) => plane[center + offset]);
  const mean = tones.reduce((a, b) => a + b, 0) / tones.length;
  const deviation = Math.sqrt(
    tones.reduce((a, b) => a + (b - mean) ** 2, 0) / tones.length,
  );
  return { tones, mean, deviation };
}

function correlation(a: Patch, b: Patch) {
  let sum = 0;
  for (let i = 0; i < a.tones.length; i++)
    sum += (a.tones[i] - a.mean) * (b.tones[i] - b.mean);
  return sum / (a.tones.length * a.deviation * b.deviation || 1);
}

/** The expanded guide hid a collar of real, surviving print from LaMa.
 * Test that blind prediction before trusting its geometry under the letters. */
function verifiedCollar(
  source: Uint8Array,
  guide: Uint8Array,
  condition: Uint8Array,
  distance: Float32Array,
) {
  let n = 0,
    sa = 0,
    sb = 0,
    aa = 0,
    bb = 0,
    ab = 0,
    absolute = 0;
  for (let i = 0; i < condition.length; i++) {
    if (!condition[i] || distance[i] < 2) continue;
    const a = source[i],
      b = guide[i];
    n++;
    sa += a;
    sb += b;
    aa += a * a;
    bb += b * b;
    ab += a * b;
    absolute += Math.abs(a - b);
  }
  if (n < 180 || absolute / n > 30 || Math.abs(sa - sb) > 13 * n) return false;
  const va = aa - (sa * sa) / n,
    vb = bb - (sb * sb) / n;
  return (
    va > 1600 * n && vb > 0 && ab - (sa * sb) / n > 0.84 * Math.sqrt(va * vb)
  );
}

function guideBounds(input: Input) {
  const box = input.inkBounds;
  if (
    !box ||
    Math.min(box.w, box.h) < 18 ||
    Math.max(box.w, box.h) > 400 ||
    Math.max(box.w, box.h) < 1.7 * Math.min(box.w, box.h) ||
    box.w * box.h > 40000
  )
    return;
  return box;
}

function guidePlanes(
  { original, stencil }: Input,
  bitmap: Buffer,
  area: number,
) {
  const source = new Uint8Array(stencil.length),
    guide = new Uint8Array(stencil.length);
  let count = 0,
    dark = 0,
    light = 0;
  for (let i = 0; i < source.length; i++) {
    const p = 4 * i;
    if (
      original[p] !== original[p + 1] ||
      original[p] !== original[p + 2] ||
      original[p + 3] !== 255
    )
      return;
    source[i] = original[p];
    guide[i] =
      (29 * bitmap[p] + 150 * bitmap[p + 1] + 77 * bitmap[p + 2] + 128) >> 8;
    if (stencil[i]) {
      count++;
      dark += Number(source[i] < 60);
      light += Number(source[i] > 235);
    }
  }
  if (
    count < 450 ||
    count > 0.64 * area ||
    dark < 0.14 * count ||
    light < 0.47 * count
  )
    return;
  return { source, guide };
}
type Region = NonNullable<ReturnType<typeof guideBounds>>;
function addContrast(
  width: number,
  guide: Uint8Array,
  weight: Float32Array,
  adjustment: Float32Array,
  i: number,
  target: Patch,
  donor: Patch,
) {
  const gain =
    Math.max(0.85, Math.min(1.55, donor.deviation / target.deviation)) - 1;
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -4; dx <= 4; dx++) {
      const j = i + dy * width + dx;
      const w = (5 - Math.abs(dx)) * (5 - Math.abs(dy));
      weight[j] += w;
      adjustment[j] +=
        w * ((guide[j] - target.mean) * gain + donor.mean - target.mean);
    }
}

function matchScreenPatches(
  { width, height }: Input,
  source: Uint8Array,
  guide: Uint8Array,
  distance: Float32Array,
  offsets: number[],
) {
  const patches = new Map<number, Patch>();
  return function findDonor(x: number, y: number, i: number, target: Patch) {
    let best = Infinity,
      donor: Patch | undefined;
    for (
      let dy = Math.max(-36, 5 - y);
      dy <= Math.min(36, height - y - 6);
      dy++
    )
      for (
        let dx = Math.max(-36, 5 - x);
        dx <= Math.min(36, width - x - 6);
        dx++
      ) {
        const j = i + dy * width + dx;
        // The complete donor patch must be free of typography and its keyline.
        if (distance[j] < 9 || Math.abs(source[j] - guide[i]) > 48) continue;
        let observed = patches.get(j);
        if (!observed) {
          observed = patch(source, j, offsets);
          patches.set(j, observed);
        }
        if (
          observed.deviation < 16 ||
          Math.abs(observed.mean - target.mean) > 12
        )
          continue;
        const match = correlation(target, observed);
        if (match < 0.84) continue;
        const score =
          64 * (1 - match) +
          Math.abs(observed.mean - target.mean) +
          0.035 * (Math.abs(dx) + Math.abs(dy));
        if (score < best) {
          best = score;
          donor = observed;
        }
      }
    return donor;
  };
}

async function measureGuide(
  input: Input,
  box: Region,
  source: Uint8Array,
  guide: Uint8Array,
  distance: Float32Array,
  signal?: AbortSignal,
) {
  const { width, height, stencil } = input;
  const offsets = [-4, -2, 0, 2, 4].flatMap((y) =>
    [-4, -2, 0, 2, 4].map((x) => y * width + x),
  );
  const weight = new Float32Array(source.length),
    adjustment = new Float32Array(source.length);
  const findDonor = matchScreenPatches(input, source, guide, distance, offsets);
  let nextYield = performance.now() + 16;
  let supported = 0,
    sampled = 0;
  for (
    let y = Math.max(5, box.y);
    y < Math.min(height - 5, box.y + box.h);
    y += 4
  ) {
    if (performance.now() > nextYield) {
      await yieldToMain(undefined, { signal });
      nextYield = performance.now() + 16;
    }
    for (
      let x = Math.max(5, box.x);
      x < Math.min(width - 5, box.x + box.w);
      x += 4
    ) {
      const i = y * width + x;
      if (!stencil[i]) continue;
      sampled++;
      const target = patch(guide, i, offsets);
      if (target.deviation < 14) continue;
      const donor = findDonor(x, y, i, target);
      if (!donor) continue;
      supported++;
      addContrast(width, guide, weight, adjustment, i, target, donor);
    }
  }
  if (supported < 12 || supported < 0.33 * sampled) return;
  return { weight, adjustment };
}

/** Accept narrow, keylined monochrome print only when actual neighbouring
 * patches reproduce the screened guide and the withheld collar predicts well.
 * Recover dot contrast locally, keeping the guide's low-frequency linework. */
export async function restoreScreenedQwenGuide(
  input: Input,
  bitmap: Buffer,
  condition: Uint8Array,
  signal?: AbortSignal,
) {
  const box = guideBounds(input);
  if (!box) return;
  const planes = guidePlanes(input, bitmap, box.w * box.h);
  if (!planes) return;
  const { source, guide } = planes;
  const distance = printMaskGrid(input.width, input.height).distance(
    input.stencil,
  );
  if (!verifiedCollar(source, guide, condition, distance)) return;
  const fit = await measureGuide(input, box, source, guide, distance, signal);
  if (!fit) return;
  const { weight, adjustment } = fit;
  const { original } = input;
  const result = Buffer.from(original);
  for (let i = 0; i < condition.length; i++)
    if (condition[i]) {
      const tone = guide[i] + adjustment[i] / Math.max(1, weight[i]);
      result.fill(
        Math.min(255, Math.max(0, Math.round(tone))),
        4 * i,
        4 * i + 3,
      );
    }
  return result;
}

export function hasCleanSoundPaper(
  repair: Buffer,
  width: number,
  box: PixelRect,
) {
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++) {
      const p = (y * width + x) * 4;
      if (Math.min(repair[p], repair[p + 1], repair[p + 2]) < 249) return false;
    }
  return true;
}
export function hasNeutralSoundBorder(
  source: Buffer,
  width: number,
  box: PixelRect,
  rect: PixelRect,
) {
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++) {
      const p = (y * width + x) * 4;
      const b = source[p],
        g = source[p + 1],
        r = source[p + 2];
      const low = Math.min(r, g, b);
      if (source[p + 3] !== 255 || Math.max(r, g, b) - low > 5) return false;
      const border =
        x < rect.x - 5 ||
        y < rect.y - 5 ||
        x >= rect.x + rect.w + 5 ||
        y >= rect.y + rect.h + 5;
      if (border && low < 249) return false;
    }
  return true;
}

/** At a sharp typeset corner JPEG can leave a tiny alternating dark/light
 * pattern. Require both rows and columns and exclude diagonal pen strokes. */
export function isPaperChecker(
  part: { rect: PixelRect },
  cells: number[],
  width: number,
  contrast: Uint8Array,
) {
  if (Math.max(part.rect.w, part.rect.h) > 6) return false;
  const dots = cells.filter((i) => contrast[i] >= 16);
  if (dots.length < 3 || dots.length > 7) return false;
  const phase = (i: number) => ((i % width) + Math.floor(i / width)) % 2;
  if (!dots.every((i) => phase(i) === phase(dots[0]))) return false;
  const [a, b] = dots,
    dx = (b % width) - (a % width),
    dy = Math.floor(b / width) - Math.floor(a / width);
  return dots.some(
    (i) =>
      ((i % width) - (a % width)) * dy !==
      (Math.floor(i / width) - Math.floor(a / width)) * dx,
  );
}
