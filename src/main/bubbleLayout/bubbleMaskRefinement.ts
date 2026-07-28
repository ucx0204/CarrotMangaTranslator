import type { BBox } from "../../shared/textTypes";
import { erodeBinaryMask } from "./bubbleDistanceTransform";
import { extractPromptedMaskRegions } from "./bubbleMaskComponents";
import {
  isPathologicalOriginalImageMask,
  repairOriginalTextInk,
  selectOriginalInkReference,
  type OriginalInkCrop,
  type OriginalInkRgb,
} from "./bubbleOriginalInkRepair";
import type {
  BubbleMaskRefinementInput,
  BubbleMaskRefinementResult,
} from "./bubbleMaskTypes";

type Rgb = OriginalInkRgb;
type PixelCrop = OriginalInkCrop;

const POLICY_INSET_SCALE = {
  safe: 1.2,
  balanced: 1,
  maximize: 0.75,
} as const;

export function refineBubbleSafeMask(
  input: BubbleMaskRefinementInput,
): BubbleMaskRefinementResult | null {
  assertBitmapSize(input);
  const crop = clampCrop(input.bubbleBox, input.imageWidth, input.imageHeight);
  if (crop.width < 8 || crop.height < 8) return null;
  const samples = collectPromptSamples(input, crop);
  if (samples.length < 4) return null;
  const reference = input.repairOriginalTextInk
    ? selectOriginalInkReference(samples)
    : medianRgb(samples);
  const tolerance = resolveColorTolerance(samples, reference);
  const eligible = buildEligibleMask(input, crop, reference, tolerance);
  const hasUnrepairablePromptInk = input.repairOriginalTextInk
    ? repairOriginalTextInk({ input, crop, eligible, reference })
    : false;
  const filled = floodFromPrompts(input, crop, eligible);
  const promptCoverage = measurePromptCoverage(input, crop, filled);
  const edgeTouch = measureEdgeTouch(filled, crop.width, crop.height);
  if (!isCredibleFlood(filled, promptCoverage, edgeTouch)) return null;

  const insetPx = resolveSafeInsetPx(input);
  const safeMask = erodeBinaryMask(filled, crop.width, crop.height, insetPx);
  const filledArea = countMask(filled);
  const minimumArea = Math.max(24, Math.floor(filledArea * 0.025));
  const regions = extractPromptedMaskRegions({
    mask: safeMask,
    width: crop.width,
    height: crop.height,
    cropX: crop.x,
    cropY: crop.y,
    promptBoxes: input.promptBoxes,
    minimumArea,
  });
  if (regions.length === 0) return null;
  if (
    input.repairOriginalTextInk &&
    isPathologicalOriginalImageMask(
      regions,
      input.promptBoxes,
      hasUnrepairablePromptInk,
    )
  ) {
    return null;
  }
  return {
    regions,
    insetPx,
    promptCoverage,
    confidence: resolveRefinementConfidence(promptCoverage, edgeTouch, regions),
  };
}

function assertBitmapSize(input: BubbleMaskRefinementInput): void {
  const expected = input.imageWidth * input.imageHeight * 4;
  if (input.bitmap.length < expected) {
    throw new Error(
      `말풍선 안전영역 이미지 버퍼가 너무 작습니다: ${input.bitmap.length}/${expected}`,
    );
  }
}

function clampCrop(box: BBox, width: number, height: number): PixelCrop {
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const right = Math.min(width, Math.ceil(box.x + box.w));
  const bottom = Math.min(height, Math.ceil(box.y + box.h));
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function collectPromptSamples(
  input: BubbleMaskRefinementInput,
  crop: PixelCrop,
): Rgb[] {
  const samples: Rgb[] = [];
  for (const prompt of input.promptBoxes) {
    const intersection = intersectCrop(prompt, crop);
    if (!intersection) continue;
    sampleInsetGrid(input, intersection, samples);
  }
  if (samples.length < 4) {
    sampleInsetGrid(input, crop, samples);
  }
  return samples;
}

function sampleInsetGrid(
  input: BubbleMaskRefinementInput,
  area: PixelCrop,
  target: Rgb[],
): void {
  for (let row = 1; row <= 5; row += 1) {
    for (let column = 1; column <= 5; column += 1) {
      const x = Math.floor(area.x + (area.width * column) / 6);
      const y = Math.floor(area.y + (area.height * row) / 6);
      target.push(readRgb(input.bitmap, input.imageWidth, x, y));
    }
  }
}

function medianRgb(samples: Rgb[]): Rgb {
  const median = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  return {
    r: median(samples.map((sample) => sample.r)),
    g: median(samples.map((sample) => sample.g)),
    b: median(samples.map((sample) => sample.b)),
  };
}

function resolveColorTolerance(samples: Rgb[], reference: Rgb): number {
  const deviations = samples
    .map((sample) => colorDistance(sample, reference))
    .sort((left, right) => left - right);
  const percentile = deviations[Math.floor(deviations.length * 0.85)] ?? 0;
  return clamp(22 + percentile * 1.8, 24, 72);
}

function buildEligibleMask(
  input: BubbleMaskRefinementInput,
  crop: PixelCrop,
  reference: Rgb,
  tolerance: number,
): Uint8Array {
  const mask = new Uint8Array(crop.width * crop.height);
  const referenceLuma = luma(reference);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const color = readRgb(
        input.bitmap,
        input.imageWidth,
        crop.x + x,
        crop.y + y,
      );
      const distanceOk = colorDistance(color, reference) <= tolerance;
      const whiteFloorOk =
        referenceLuma < 205 || luma(color) >= Math.max(110, referenceLuma - 95);
      mask[y * crop.width + x] = distanceOk && whiteFloorOk ? 1 : 0;
    }
  }
  return mask;
}

function floodFromPrompts(
  input: BubbleMaskRefinementInput,
  crop: PixelCrop,
  eligible: Uint8Array,
): Uint8Array {
  const output = new Uint8Array(eligible.length);
  const queue: number[] = [];
  seedPromptPixels(input.promptBoxes, crop, eligible, output, queue);
  if (queue.length === 0) seedCropCenter(crop, eligible, output, queue);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    enqueueFloodNeighbors(queue[cursor], crop, eligible, output, queue);
  }
  return output;
}

function seedPromptPixels(
  prompts: BBox[],
  crop: PixelCrop,
  eligible: Uint8Array,
  output: Uint8Array,
  queue: number[],
): void {
  for (const prompt of prompts) {
    const intersection = intersectCrop(prompt, crop);
    if (!intersection) continue;
    for (let row = 1; row <= 5; row += 1) {
      for (let column = 1; column <= 5; column += 1) {
        const x = Math.floor(
          intersection.x + (intersection.width * column) / 6,
        );
        const y = Math.floor(intersection.y + (intersection.height * row) / 6);
        seedPixel(x - crop.x, y - crop.y, crop.width, eligible, output, queue);
      }
    }
  }
}

function seedCropCenter(
  crop: PixelCrop,
  eligible: Uint8Array,
  output: Uint8Array,
  queue: number[],
): void {
  seedPixel(
    Math.floor(crop.width / 2),
    Math.floor(crop.height / 2),
    crop.width,
    eligible,
    output,
    queue,
  );
}

function seedPixel(
  x: number,
  y: number,
  width: number,
  eligible: Uint8Array,
  output: Uint8Array,
  queue: number[],
): void {
  const index = y * width + x;
  if (index >= 0 && eligible[index] && !output[index]) {
    output[index] = 1;
    queue.push(index);
  }
}

function enqueueFloodNeighbors(
  index: number,
  crop: PixelCrop,
  eligible: Uint8Array,
  output: Uint8Array,
  queue: number[],
): void {
  const x = index % crop.width;
  const y = Math.floor(index / crop.width);
  const neighbors = [
    x > 0 ? index - 1 : -1,
    x + 1 < crop.width ? index + 1 : -1,
    y > 0 ? index - crop.width : -1,
    y + 1 < crop.height ? index + crop.width : -1,
  ];
  for (const neighbor of neighbors) {
    if (neighbor >= 0 && eligible[neighbor] && !output[neighbor]) {
      output[neighbor] = 1;
      queue.push(neighbor);
    }
  }
}

function measurePromptCoverage(
  input: BubbleMaskRefinementInput,
  crop: PixelCrop,
  mask: Uint8Array,
): number {
  let covered = 0;
  let total = 0;
  for (const prompt of input.promptBoxes) {
    const area = intersectCrop(prompt, crop);
    if (!area) continue;
    for (let y = area.y; y < area.y + area.height; y += 2) {
      for (let x = area.x; x < area.x + area.width; x += 2) {
        total += 1;
        covered += mask[(y - crop.y) * crop.width + x - crop.x] ?? 0;
      }
    }
  }
  return total > 0 ? covered / total : 0;
}

function measureEdgeTouch(
  mask: Uint8Array,
  width: number,
  height: number,
): number {
  let touched = 0;
  const perimeter = Math.max(1, width * 2 + height * 2 - 4);
  for (let x = 0; x < width; x += 1) {
    touched += mask[x] ?? 0;
    touched += mask[(height - 1) * width + x] ?? 0;
  }
  for (let y = 1; y < height - 1; y += 1) {
    touched += mask[y * width] ?? 0;
    touched += mask[y * width + width - 1] ?? 0;
  }
  return touched / perimeter;
}

function isCredibleFlood(
  mask: Uint8Array,
  promptCoverage: number,
  edgeTouch: number,
): boolean {
  const areaRatio = countMask(mask) / Math.max(1, mask.length);
  return (
    promptCoverage >= 0.32 &&
    areaRatio >= 0.08 &&
    areaRatio <= 0.94 &&
    edgeTouch <= 0.35
  );
}

function resolveSafeInsetPx(input: BubbleMaskRefinementInput): number {
  const base = Math.max(3, input.fontSizePx * 0.18, input.outlineWidthPx * 2.5);
  return base * POLICY_INSET_SCALE[input.policy];
}

function resolveRefinementConfidence(
  promptCoverage: number,
  edgeTouch: number,
  regions: { area: number }[],
): number {
  const regionFactor = regions.length <= 2 ? 1 : 0.9;
  return clamp(
    (0.45 + promptCoverage * 0.45 - edgeTouch * 0.5) * regionFactor,
    0,
    1,
  );
}

function intersectCrop(box: BBox, crop: PixelCrop): PixelCrop | null {
  const x = Math.max(crop.x, Math.floor(box.x));
  const y = Math.max(crop.y, Math.floor(box.y));
  const right = Math.min(crop.x + crop.width, Math.ceil(box.x + box.w));
  const bottom = Math.min(crop.y + crop.height, Math.ceil(box.y + box.h));
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}

function readRgb(
  bitmap: Uint8Array,
  imageWidth: number,
  x: number,
  y: number,
): Rgb {
  const index = (y * imageWidth + x) * 4;
  return { r: bitmap[index + 2], g: bitmap[index + 1], b: bitmap[index] };
}

function colorDistance(left: Rgb, right: Rgb): number {
  return Math.sqrt(
    ((left.r - right.r) ** 2 +
      (left.g - right.g) ** 2 +
      (left.b - right.b) ** 2) /
      3,
  );
}

function luma(color: Rgb): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}

function countMask(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) count += value;
  return count;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
