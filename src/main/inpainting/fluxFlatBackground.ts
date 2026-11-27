import type { InpaintingWindowMask } from "./inpaintingEngine";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import { restoreVerifiedFluxCaptionGradient } from "./fluxCaptionGradient";
import { expandRect, type PixelRect } from "./maskGeometry";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import { maskComponents } from "./rasterMasks";
import { distanceFromMaskBoundary } from "../bubbleLayout/bubbleDistanceTransform";

type FlatBackgroundInput = {
  source: Buffer;
  generated: Buffer;
  constraint: InpaintingWindowMask | null;
  crop: PixelRect;
  width: number;
  height: number;
  speechBubble?: boolean;
  nativeFlux?: boolean;
  core?: InpaintingWindowMask;
};

/**
 * A generator can invent a bubble on black paper or marks on white paper.
 * Only correct explicitly owned regions with consistent source-paper evidence.
 * Textured/edge-crossing regions keep the generated pixels.
 * The existing compositor still owns all page writes and feathering.
 */
export function restoreFluxFlatBackground(
  input: FlatBackgroundInput,
  contextGenerated?: Buffer,
): void {
  const constraint = input.constraint;
  if (!constraint) return;
  for (const component of maskComponents(
    constraint.data,
    constraint.bounds.w,
    constraint.bounds.h,
    16,
  )) {
    const mask = {
      bounds: {
        ...component.rect,
        x: component.rect.x + constraint.bounds.x,
        y: component.rect.y + constraint.bounds.y,
      },
      data: component.data,
    };
    const exterior = surroundingFlatColor(input, mask, constraint);
    if (exterior && contextGenerated)
      paintCandidate({ ...input, generated: contextGenerated }, mask, exterior);
    // A solid panel surrounding a balloon can be a completely different colour
    // from its paper. Only the verified inside colour belongs in the final edit.
    restoreFinalPaper(input, mask, component.area, exterior);
  }
}

function restoreFinalPaper(
  input: FlatBackgroundInput,
  mask: InpaintingWindowMask,
  area: number,
  exterior: number[] | null,
) {
  const exteriorUnsupported =
    exterior &&
    input.nativeFlux &&
    input.speechBubble &&
    input.core &&
    !hasDominantPaperColor(input, mask, exterior, area);
  const color =
    (exteriorUnsupported ? null : exterior) ??
    interiorFlatColor(input, mask) ??
    ownedRimFlatColor(input, mask);
  if (color) paintCandidate(input, mask, color);
  else if (exteriorUnsupported && input.core)
    restoreVerifiedFluxCaptionGradient(input, mask, input.core);
}

/** A clipped balloon's outside ring can contain its inked outline or artwork.
 * Use the inside ring only for detected balloons, excluding the owned text
 * core. Keep the original strict colour test and require distributed evidence.
 */
function interiorFlatColor(
  input: FlatBackgroundInput,
  mask: InpaintingWindowMask,
): number[] | null {
  if (!input.speechBubble || !input.core) return null;
  const { bounds, data } = mask;
  const distances = distanceFromMaskBoundary(data, bounds.w, bounds.h);
  const core = projectWindowMask(input.core, bounds);
  const channels: number[][] = [[], [], []];
  const quadrants = [0, 0, 0, 0];
  let ringPixels = 0;
  let ringSamples = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i] || distances[i] <= 2) continue;
    const inRing = distances[i] <= 5;
    ringPixels += Number(inRing);
    if (core[i]) continue;
    const x = i % bounds.w;
    const y = Math.floor(i / bounds.w);
    if (inRing) {
      ringSamples++;
      quadrants[Number(x >= bounds.w / 2) + 2 * Number(y >= bounds.h / 2)]++;
    }
    const offset = ((bounds.y + y) * input.width + bounds.x + x) * 4;
    for (let c = 0; c < 3; c++) channels[c].push(input.source[offset + c]);
  }
  if (
    ringSamples < Math.max(64, ringPixels * 0.25) ||
    quadrants.filter((count) => count >= 16).length < 3
  )
    return null;
  return flatSampleColor(channels);
}

/** Small balloons can have a core covering almost all their paper. Require a
 * complete flat inner rim and dominant matching paper before using that rim.
 * Any unowned interior artwork still vetoes the correction.
 */
function ownedRimFlatColor(
  input: FlatBackgroundInput,
  mask: InpaintingWindowMask,
): number[] | null {
  if (!input.speechBubble || !input.core) return null;
  const { bounds, data } = mask;
  const core = projectWindowMask(input.core, bounds);
  const total = data.reduce((count, value) => count + Number(!!value), 0);
  const owned = data.reduce(
    (count, value, i) => count + Number(!!value && !!core[i]),
    0,
  );
  if (owned < total * 0.9) return null;
  const { channels, quadrants } = sampleOwnedRim(input, mask, core);
  const color = distributedFlatColor(channels, quadrants);
  return color && hasDominantPaperColor(input, mask, color, total)
    ? color
    : null;
}

function sampleOwnedRim(
  input: FlatBackgroundInput,
  mask: InpaintingWindowMask,
  core: Uint8Array,
) {
  const { bounds, data } = mask;
  const distances = distanceFromMaskBoundary(data, bounds.w, bounds.h);
  const channels: number[][] = [[], [], []];
  const quadrants = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const x = i % bounds.w;
    const y = Math.floor(i / bounds.w);
    const inRing = distances[i] > 1 && distances[i] <= 3;
    if (inRing)
      quadrants[Number(x >= bounds.w / 2) + 2 * Number(y >= bounds.h / 2)]++;
    if (!inRing && (core[i] || distances[i] <= 2)) continue;
    const offset = ((bounds.y + y) * input.width + bounds.x + x) * 4;
    for (let c = 0; c < 3; c++) channels[c].push(input.source[offset + c]);
  }
  return { channels, quadrants };
}

function distributedFlatColor(
  channels: number[][],
  quadrants: number[],
): number[] | null {
  if (
    quadrants.reduce((sum, count) => sum + count, 0) < 64 ||
    quadrants.filter((count) => count >= 16).length < 3
  )
    return null;
  return flatSampleColor(channels);
}

function hasDominantPaperColor(
  input: FlatBackgroundInput,
  mask: InpaintingWindowMask,
  color: number[],
  total: number,
): boolean {
  const { bounds, data } = mask;
  let matching = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const offset =
      ((bounds.y + Math.floor(i / bounds.w)) * input.width +
        bounds.x +
        (i % bounds.w)) *
      4;
    matching += Number(
      color.every(
        (value, c) => Math.abs(input.source[offset + c] - value) <= 24,
      ),
    );
  }
  return matching >= total * 0.8;
}

function surroundingFlatColor(
  input: FlatBackgroundInput,
  mask: InpaintingWindowMask,
  constraint: InpaintingWindowMask,
): number[] | null {
  const { bounds } = mask;
  if (
    bounds.x < 3 ||
    bounds.y < 3 ||
    bounds.x + bounds.w > input.width - 3 ||
    bounds.y + bounds.h > input.height - 3
  )
    return null;
  const expanded = expandRect(bounds, input.width, input.height, 3);
  const local = projectWindowMask(mask, expanded);
  const occupied = projectWindowMask(constraint, expanded);
  const ring = dilateBinaryMaskDisk(local, expanded.w, expanded.h, 3);
  const channels: number[][] = [[], [], []];
  for (let i = 0; i < ring.length; i++) {
    if (!ring[i] || occupied[i]) continue;
    const offset =
      ((expanded.y + Math.floor(i / expanded.w)) * input.width +
        expanded.x +
        (i % expanded.w)) *
      4;
    for (let c = 0; c < 3; c++) channels[c].push(input.source[offset + c]);
  }
  if (channels[0].length < 64) return null;
  return flatSampleColor(channels);
}

function flatSampleColor(channels: number[][]): number[] | null {
  const color: number[] = [];
  for (const channel of channels) {
    const histogram = new Uint32Array(256);
    let low = 255,
      high = 0;
    for (const value of channel) {
      low = Math.min(low, value);
      high = Math.max(high, value);
      if (high - low > 48) return null;
      histogram[value]++;
    }
    let median = low,
      count = histogram[low];
    while (count <= Math.floor(channel.length / 2))
      count += histogram[++median];
    if (median - low > 24 || high - median > 24) return null;
    let squares = 0;
    for (let value = low; value <= high; value++)
      squares += histogram[value] * (value - median) ** 2;
    if (squares > 25 * channel.length) return null;
    color.push(median);
  }
  return color;
}

function paintCandidate(
  input: FlatBackgroundInput,
  mask: InpaintingWindowMask,
  color: number[],
): void {
  for (let y = 0; y < mask.bounds.h; y++) {
    const cy = mask.bounds.y + y - input.crop.y;
    if (cy < 0 || cy >= input.crop.h) continue;
    for (let x = 0; x < mask.bounds.w; x++) {
      const cx = mask.bounds.x + x - input.crop.x;
      if (!mask.data[y * mask.bounds.w + x] || cx < 0 || cx >= input.crop.w)
        continue;
      const offset = (cy * input.crop.w + cx) * 4;
      const alpha = input.nativeFlux ? input.generated[offset + 3] : 255;
      for (let c = 0; c < 3; c++)
        input.generated[offset + c] = Math.min(alpha, color[c]);
    }
  }
}
