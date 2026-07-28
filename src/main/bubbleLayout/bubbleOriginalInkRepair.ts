import type { BBox } from "../../shared/textTypes";
import type { BubbleMaskRefinementInput } from "./bubbleMaskTypes";

export type OriginalInkRgb = { r: number; g: number; b: number };
export type OriginalInkCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DarkComponent = {
  pixels: number[];
  left: number;
  top: number;
  right: number;
  bottom: number;
  lumaTotal: number;
  touchesCropEdge: boolean;
};

export function selectOriginalInkReference(
  samples: readonly OriginalInkRgb[],
): OriginalInkRgb {
  const ordered = [...samples].sort((left, right) => luma(left) - luma(right));
  return ordered[Math.floor((ordered.length - 1) * 0.78)] ?? samples[0];
}

/**
 * Restore only dark components fully enclosed by an OCR prompt. Source glyphs
 * satisfy that constraint; panel borders, balloon outlines and crop-crossing
 * artwork do not.
 */
export function repairOriginalTextInk(options: {
  input: BubbleMaskRefinementInput;
  crop: OriginalInkCrop;
  eligible: Uint8Array;
  reference: OriginalInkRgb;
}): boolean {
  const { input, crop, eligible, reference } = options;
  const visited = new Uint8Array(eligible.length);
  const referenceLuma = luma(reference);
  let hasUnrepairablePromptInk = false;
  for (let start = 0; start < eligible.length; start += 1) {
    if (eligible[start] || visited[start]) continue;
    const component = collectDarkComponent(
      input,
      crop,
      eligible,
      visited,
      start,
    );
    if (
      !component.touchesCropEdge &&
      component.pixels.length > 0 &&
      component.pixels.length <=
        Math.max(24, crop.width * crop.height * 0.12) &&
      component.lumaTotal / component.pixels.length <= referenceLuma - 36 &&
      componentFitsPrompt(component, crop, input.promptBoxes)
    ) {
      for (const index of component.pixels) eligible[index] = 1;
    } else if (
      component.touchesCropEdge &&
      componentHasPromptPixel(component, crop, input.promptBoxes)
    ) {
      hasUnrepairablePromptInk = true;
    }
  }
  return hasUnrepairablePromptInk;
}

export function isPathologicalOriginalImageMask(
  regions: readonly { bounds: BBox; area: number }[],
  prompts: readonly BBox[],
  hasUnrepairablePromptInk: boolean,
): boolean {
  const totalArea = regions.reduce((sum, region) => sum + region.area, 0);
  const left = Math.min(...regions.map((region) => region.bounds.x));
  const top = Math.min(...regions.map((region) => region.bounds.y));
  const right = Math.max(
    ...regions.map((region) => region.bounds.x + region.bounds.w),
  );
  const bottom = Math.max(
    ...regions.map((region) => region.bounds.y + region.bounds.h),
  );
  const envelopeFill = totalArea / Math.max(1, (right - left) * (bottom - top));
  if (envelopeFill < 0.34) return true;

  const largestArea = Math.max(...regions.map((region) => region.area));
  if (regions.length >= 3 && largestArea / Math.max(1, totalArea) < 0.72) {
    return true;
  }
  if (
    hasUnrepairablePromptInk &&
    prompts.some(
      (prompt) =>
        regions.filter(
          (region) =>
            intersectionArea(region.bounds, prompt) >=
            Math.max(4, prompt.w * prompt.h * 0.08),
        ).length >= 2,
    )
  ) {
    return true;
  }

  const promptArea = prompts.reduce(
    (sum, prompt) => sum + prompt.w * prompt.h,
    0,
  );
  const promptIntersection = prompts.reduce(
    (sum, prompt) =>
      sum +
      regions.reduce(
        (regionSum, region) =>
          regionSum + intersectionArea(region.bounds, prompt),
        0,
      ),
    0,
  );
  return promptArea > 0 && promptIntersection / promptArea < 0.22;
}

function collectDarkComponent(
  input: BubbleMaskRefinementInput,
  crop: OriginalInkCrop,
  eligible: Uint8Array,
  visited: Uint8Array,
  start: number,
): DarkComponent {
  const queue = [start];
  const pixels: number[] = [];
  visited[start] = 1;
  let left = start % crop.width;
  let right = left;
  let top = Math.floor(start / crop.width);
  let bottom = top;
  let lumaTotal = 0;
  let touchesCropEdge = false;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    const x = index % crop.width;
    const y = Math.floor(index / crop.width);
    pixels.push(index);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    touchesCropEdge ||=
      x === 0 || y === 0 || x === crop.width - 1 || y === crop.height - 1;
    lumaTotal += luma(
      readRgb(input.bitmap, input.imageWidth, crop.x + x, crop.y + y),
    );
    enqueueDarkNeighbors(eligible, visited, crop, x, y, queue);
  }
  return {
    pixels,
    left,
    top,
    right,
    bottom,
    lumaTotal,
    touchesCropEdge,
  };
}

function enqueueDarkNeighbors(
  eligible: Uint8Array,
  visited: Uint8Array,
  crop: OriginalInkCrop,
  x: number,
  y: number,
  queue: number[],
): void {
  const neighbors = [
    x > 0 ? y * crop.width + x - 1 : -1,
    x + 1 < crop.width ? y * crop.width + x + 1 : -1,
    y > 0 ? (y - 1) * crop.width + x : -1,
    y + 1 < crop.height ? (y + 1) * crop.width + x : -1,
  ];
  for (const index of neighbors) {
    if (index >= 0 && !eligible[index] && !visited[index]) {
      visited[index] = 1;
      queue.push(index);
    }
  }
}

function componentFitsPrompt(
  component: DarkComponent,
  crop: OriginalInkCrop,
  prompts: readonly BBox[],
): boolean {
  const pageBounds = {
    x: crop.x + component.left,
    y: crop.y + component.top,
    w: component.right - component.left + 1,
    h: component.bottom - component.top + 1,
  };
  return prompts.some((prompt) => {
    const tolerance = 1;
    const contains =
      pageBounds.x >= prompt.x - tolerance &&
      pageBounds.y >= prompt.y - tolerance &&
      pageBounds.x + pageBounds.w <= prompt.x + prompt.w + tolerance &&
      pageBounds.y + pageBounds.h <= prompt.y + prompt.h + tolerance;
    if (!contains) return false;
    return (
      pageBounds.w <= Math.max(12, prompt.w * 0.72) ||
      pageBounds.h <= Math.max(12, prompt.h * 0.72)
    );
  });
}

function componentHasPromptPixel(
  component: DarkComponent,
  crop: OriginalInkCrop,
  prompts: readonly BBox[],
): boolean {
  return component.pixels.some((index) => {
    const pageX = crop.x + (index % crop.width);
    const pageY = crop.y + Math.floor(index / crop.width);
    return prompts.some(
      (prompt) =>
        pageX >= prompt.x &&
        pageY >= prompt.y &&
        pageX < prompt.x + prompt.w &&
        pageY < prompt.y + prompt.h,
    );
  });
}

function intersectionArea(left: BBox, right: BBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.w, right.x + right.w);
  const y2 = Math.min(left.y + left.h, right.y + right.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function readRgb(
  bitmap: Uint8Array,
  imageWidth: number,
  x: number,
  y: number,
): OriginalInkRgb {
  const index = (y * imageWidth + x) * 4;
  return { r: bitmap[index + 2], g: bitmap[index + 1], b: bitmap[index] };
}

function luma(color: OriginalInkRgb): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}
