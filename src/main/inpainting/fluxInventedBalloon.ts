import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import { cropBitmapFromPage } from "./imageRaster";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect, type PixelRect } from "./maskGeometry";
import { maskComponents } from "./rasterMasks";

type Component = ReturnType<typeof maskComponents>[number];
type PaperSample = {
  source: Buffer;
  generated: Buffer;
  owned: Uint8Array;
  width: number;
  height: number;
};

function lightestInk(bitmap: Buffer, pixel: number): number {
  const i = pixel * 4;
  return Math.max(bitmap[i], bitmap[i + 1], bitmap[i + 2]);
}

function darkestChannel(bitmap: Buffer, pixel: number): number {
  const i = pixel * 4;
  return Math.min(bitmap[i], bitmap[i + 1], bitmap[i + 2]);
}

function offsetInSample(component: Component, index: number, width: number) {
  const { x, y, w } = component.rect;
  return (y + Math.floor(index / w)) * width + x + (index % w);
}

/** Measure the outside of the generated white island, including antialiasing.
 * An existing frame displaced by a pixel during decoding still has source ink. */
function isNewOutline(sample: PaperSample, island: Component): boolean {
  const { rect, data, area } = island;
  if (rect.w < 12 || rect.h < 12 || area < rect.w * rect.h * 0.5) return false;
  if (
    Math.min(
      rect.x,
      rect.y,
      sample.width - rect.x - rect.w,
      sample.height - rect.y - rect.h,
    ) < 3
  )
    return false;
  const rim = new Set<number>();
  let owned = 0,
    paper = 0,
    ink = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const p = offsetInSample(island, i, sample.width);
    owned += Number(!!sample.owned[p]);
    paper += Number(darkestChannel(sample.source, p) >= 224);
    ink += Number(lightestInk(sample.source, p) < 150);
    for (const step of [-sample.width, -1, 1, sample.width]) {
      if (darkestChannel(sample.generated, p + step) >= 218) continue;
      rim.add(p + step);
      rim.add(p + 2 * step);
    }
  }
  if (owned < area * 0.75 || paper < area * 0.55 || ink < area * 0.018)
    return false;
  return hasDistributedNewInk(sample, rect, rim);
}

function hasDistributedNewInk(
  sample: PaperSample,
  rect: PixelRect,
  rim: Set<number>,
) {
  const quadrants = [0, 0, 0, 0];
  let dark = 0,
    novel = 0;
  for (const p of rim) {
    if (lightestInk(sample.generated, p) >= 150) continue;
    dark++;
    if (!sample.owned[p] || !sourceWasPaper(sample, p)) continue;
    novel++;
    const x = p % sample.width,
      y = Math.floor(p / sample.width);
    quadrants[
      Number(x >= rect.x + rect.w / 2) + 2 * Number(y >= rect.y + rect.h / 2)
    ]++;
  }
  return (
    dark >= rim.size * 0.4 &&
    novel >= Math.max(24, dark * 0.28) &&
    quadrants.filter((n) => n >= 4).length >= 3
  );
}

function sourceWasPaper(sample: PaperSample, p: number) {
  for (const offset of [0, -1, 1, -sample.width, sample.width])
    if (darkestChannel(sample.source, p + offset) < 216) return false;
  return true;
}

/** Keep source lines that continue out of the text mask. Isolated glyphs
 * inside the mask cannot supply linework to the replacement. */
function sourceLinework(sample: PaperSample): Uint8Array {
  const bits = Uint8Array.from(sample.owned, (_, p) =>
    Number(darkestChannel(sample.source, p) < 190),
  );
  const keep = new Uint8Array(bits.length);
  for (const part of maskComponents(bits, sample.width, sample.height, 12)) {
    let outside = 0;
    for (let i = 0; i < part.data.length; i++)
      if (part.data[i] && !sample.owned[offsetInSample(part, i, sample.width)])
        outside++;
    if (outside < 10) continue;
    for (let i = 0; i < part.data.length; i++)
      if (part.data[i]) keep[offsetInSample(part, i, sample.width)] = 1;
  }
  return keep;
}

function repairIsland(
  sample: PaperSample,
  island: Component,
  keep: Uint8Array,
  result: Buffer,
  crop: PixelRect,
  local: PixelRect,
) {
  const radius = Math.min(
    16,
    Math.max(4, Math.round(Math.min(island.rect.w, island.rect.h) * 0.18)),
  );
  const bounds = expandRect(island.rect, sample.width, sample.height, radius);
  // Distance to the actual white interior also includes the narrow balloon tail.
  const envelope = projectWindowMask(
    { bounds: island.rect, data: island.data },
    bounds,
  );
  const reached = expandBalloonInterior(envelope, bounds.w, radius);
  const paper = [0, 1, 2].map((channel) => {
    const values: number[] = [];
    island.data.forEach((on, i) => {
      if (!on) return;
      const p = offsetInSample(island, i, sample.width);
      if (darkestChannel(sample.source, p) >= 224)
        values.push(sample.source[4 * p + channel]);
    });
    return values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  });
  for (let i = 0; i < reached.length; i++) {
    if (!reached[i]) continue;
    const x = bounds.x + (i % bounds.w),
      y = bounds.y + Math.floor(i / bounds.w),
      p = y * sample.width + x;
    if (!sample.owned[p]) continue;
    const target = 4 * ((local.y + y) * crop.w + local.x + x);
    for (let c = 0; c < 3; c++)
      result[target + c] = keep[p] ? sample.source[4 * p + c] : paper[c];
  }
}

function expandBalloonInterior(
  envelope: Uint8Array,
  width: number,
  radius: number,
) {
  const reached = new Uint8Array(envelope);
  let frontier = Array.from(envelope.keys()).filter((i) => envelope[i]);
  for (let pass = 0; pass < radius; pass++) {
    const next: number[] = [];
    const visit = (i: number) => {
      if (i < 0 || i >= reached.length || reached[i]) return;
      reached[i] = 1;
      next.push(i);
    };
    for (const i of frontier) {
      const x = i % width;
      if (x > 0) visit(i - 1);
      if (x + 1 < width) visit(i + 1);
      visit(i - width);
      visit(i + width);
    }
    frontier = next;
  }
  return reached;
}

/** Correct only an enclosed, newly inked balloon over demonstrable light source paper.
 * Return a separate final candidate so later crops see their original inference context. */
export function suppressInventedFluxBalloon(input: {
  source: Buffer;
  generated: Buffer;
  width: number;
  crop: PixelRect;
  core?: InpaintingWindowMask;
}): Buffer {
  const { core, crop, generated } = input;
  if (!core) return generated;
  const left = Math.max(0, core.bounds.x - crop.x - 18),
    top = Math.max(0, core.bounds.y - crop.y - 18);
  const right = Math.min(crop.w, core.bounds.x + core.bounds.w - crop.x + 18),
    bottom = Math.min(crop.h, core.bounds.y + core.bounds.h - crop.y + 18);
  if (right - left < 18 || bottom - top < 18) return generated;
  const local = { x: left, y: top, w: right - left, h: bottom - top };
  const page = { ...local, x: crop.x + left, y: crop.y + top };
  const sample: PaperSample = {
    width: local.w,
    height: local.h,
    source: cropBitmapFromPage(input.source, input.width, page),
    generated: cropBitmapFromPage(generated, crop.w, local),
    owned: projectWindowMask(core, page),
  };
  const white = Uint8Array.from(sample.owned, (_, p) =>
    Number(darkestChannel(sample.generated, p) >= 218),
  );
  const islands = maskComponents(white, local.w, local.h, 180).filter((part) =>
    isNewOutline(sample, part),
  );
  if (!islands.length) return generated;
  const keep = sourceLinework(sample),
    result = Buffer.from(generated);
  for (const island of islands)
    repairIsland(sample, island, keep, result, crop, local);
  return result;
}
