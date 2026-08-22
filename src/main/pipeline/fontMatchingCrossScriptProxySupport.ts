/* eslint-disable complexity, max-depth, max-lines -- deterministic pixel traversal and glyph extraction stay auditable in one unit */
import type { BBox } from "../../shared/textTypes";
import type { FontMatchingSourceGlyphInputV1 } from "./fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRasterPage } from "./fontMatchingPagePixelPreprocessing";

export const CROSS_SCRIPT_PROXY_IMAGE_SIZE = 96;
export const CROSS_SCRIPT_PROXY_SUPPORT_COUNT = 8;
const CANONICAL_INK_SIZE = Math.round(CROSS_SCRIPT_PROXY_IMAGE_SIZE * 0.76);

type GrayImage = Readonly<{
  width: number;
  height: number;
  data: Uint8Array;
}>;

type BinaryImage = Readonly<{
  width: number;
  height: number;
  data: Uint8Array;
}>;

type Component = Readonly<{
  area: number;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/** Build [8,1,96,96] white-ink-on-black glyph cells. */
export function prepareCrossScriptProxySupport(
  page: FontMatchingRasterPage,
  bbox: BBox,
  input: FontMatchingSourceGlyphInputV1,
  signal?: AbortSignal,
): Float32Array | null {
  throwIfAborted(signal);
  const lineComponents = extractLineComponents(page, input, signal);
  const components =
    lineComponents.length >= Math.min(3, input.fallbackGlyphCount)
      ? lineComponents
      : extractFallbackComponents(page, bbox, input, signal);
  if (components.length === 0) return null;
  const selected = selectEvenly(components, CROSS_SCRIPT_PROXY_SUPPORT_COUNT);
  const output = new Float32Array(
    CROSS_SCRIPT_PROXY_SUPPORT_COUNT * CROSS_SCRIPT_PROXY_IMAGE_SIZE ** 2,
  );
  for (let index = 0; index < CROSS_SCRIPT_PROXY_SUPPORT_COUNT; index += 1) {
    const component = selected[index % selected.length];
    if (!component) return null;
    output.set(
      component,
      index * CROSS_SCRIPT_PROXY_IMAGE_SIZE * CROSS_SCRIPT_PROXY_IMAGE_SIZE,
    );
  }
  return output;
}

function extractLineComponents(
  page: FontMatchingRasterPage,
  input: FontMatchingSourceGlyphInputV1,
  signal?: AbortSignal,
): Float32Array[] {
  if (input.lines.length === 0) return [];
  const maximumGlyphSize = Math.max(
    ...input.lines.map((line) => estimateGlyphSize(line, input.direction)),
  );
  const components: Float32Array[] = [];
  for (const line of input.lines) {
    throwIfAborted(signal);
    if (estimateGlyphSize(line, input.direction) < maximumGlyphSize * 0.65) {
      continue;
    }
    const crop = cropPageGrayscale(page, {
      x1: Math.floor(line.x1) - 2,
      y1: Math.floor(line.y1) - 2,
      x2: Math.ceil(line.x2) + 2,
      y2: Math.ceil(line.y2) + 2,
    });
    if (!crop) continue;
    const binary = darkOtsuMask(crop);
    components.push(
      ...splitEqualCells(binary, input.direction, line.glyphCount),
    );
  }
  return components;
}

function estimateGlyphSize(
  line: FontMatchingSourceGlyphInputV1["lines"][number],
  direction: FontMatchingSourceGlyphInputV1["direction"],
): number {
  const width = Math.max(1, line.x2 - line.x1);
  const height = Math.max(1, line.y2 - line.y1);
  const along = direction === "vertical" ? height : width;
  const across = direction === "vertical" ? width : height;
  return Math.min(across, along / Math.max(1, line.glyphCount));
}

function extractFallbackComponents(
  page: FontMatchingRasterPage,
  bbox: BBox,
  input: FontMatchingSourceGlyphInputV1,
  signal?: AbortSignal,
): Float32Array[] {
  const crop = cropNormalizedBbox(page, bbox, 2);
  if (!crop) return [];
  const binary = darkOtsuMask(crop);
  const equal = splitEqualCells(
    binary,
    input.direction,
    input.fallbackGlyphCount,
  );
  if (equal.length >= Math.min(3, input.fallbackGlyphCount)) return equal;
  throwIfAborted(signal);
  const joined = closeMask(binary);
  const cropArea = joined.width * joined.height;
  const minimumArea = Math.max(4, Math.round(cropArea * 0.00045));
  const candidates = connectedComponents(joined)
    .filter(
      (component) =>
        component.area >= minimumArea &&
        component.area <= cropArea * 0.28 &&
        component.width >= 2 &&
        component.height >= 2 &&
        Math.max(
          component.width / component.height,
          component.height / component.width,
        ) <= 7 &&
        !(touchesEdge(component, joined) && component.area > cropArea * 0.02),
    )
    .sort(
      (left, right) =>
        right.area - left.area || left.y - right.y || left.x - right.x,
    )
    .slice(0, Math.max(CROSS_SCRIPT_PROXY_SUPPORT_COUNT * 2, 12))
    .sort((left, right) => left.y - right.y || left.x - right.x);
  if (candidates.length === 0) {
    const fallback = canonicalizeComponent(
      binary.data,
      binary.width,
      binary.height,
    );
    return fallback ? [fallback] : [];
  }
  return selectEvenly(candidates, CROSS_SCRIPT_PROXY_SUPPORT_COUNT)
    .map((component) => cropBinary(binary, component))
    .map((component) =>
      canonicalizeComponent(component.data, component.width, component.height),
    )
    .filter((value): value is Float32Array => value !== null);
}

function splitEqualCells(
  image: BinaryImage,
  direction: "horizontal" | "vertical",
  count: number,
): Float32Array[] {
  if (count < 2) return [];
  const axisSize = direction === "vertical" ? image.height : image.width;
  const components: Float32Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.round((axisSize * index) / count);
    const stop = Math.round((axisSize * (index + 1)) / count);
    if (stop <= start) continue;
    const width = direction === "vertical" ? image.width : stop - start;
    const height = direction === "vertical" ? stop - start : image.height;
    const cell = new Uint8Array(width * height);
    let ink = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourceX = direction === "vertical" ? x : x + start;
        const sourceY = direction === "vertical" ? y + start : y;
        const value = image.data[sourceY * image.width + sourceX] ?? 0;
        cell[y * width + x] = value;
        ink += value;
      }
    }
    const fraction = ink / Math.max(1, cell.length);
    if (fraction < 0.008 || fraction > 0.62) continue;
    const canonical = canonicalizeComponent(cell, width, height);
    if (canonical) components.push(canonical);
  }
  return components;
}

function canonicalizeComponent(
  mask: Uint8Array,
  width: number,
  height: number,
): Float32Array | null {
  let x1 = width;
  let y1 = height;
  let x2 = 0;
  let y2 = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x + 1);
      y2 = Math.max(y2, y + 1);
    }
  }
  if (x2 <= x1 || y2 <= y1) return null;
  const sourceWidth = x2 - x1;
  const sourceHeight = y2 - y1;
  const scale = Math.min(
    CANONICAL_INK_SIZE / sourceWidth,
    CANONICAL_INK_SIZE / sourceHeight,
  );
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  const resized = resizeBilinearMask({
    mask,
    width,
    height,
    x1,
    y1,
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
  });
  const canvas = new Float32Array(CROSS_SCRIPT_PROXY_IMAGE_SIZE ** 2);
  const targetX = Math.floor((CROSS_SCRIPT_PROXY_IMAGE_SIZE - targetWidth) / 2);
  const targetY = Math.floor(
    (CROSS_SCRIPT_PROXY_IMAGE_SIZE - targetHeight) / 2,
  );
  for (let y = 0; y < targetHeight; y += 1) {
    canvas.set(
      resized.subarray(y * targetWidth, (y + 1) * targetWidth),
      (targetY + y) * CROSS_SCRIPT_PROXY_IMAGE_SIZE + targetX,
    );
  }
  const blurred = gaussianBlur3(canvas, CROSS_SCRIPT_PROXY_IMAGE_SIZE);
  let maximum = 0;
  for (const value of blurred) maximum = Math.max(maximum, value);
  if (maximum <= 0) return null;
  for (let index = 0; index < blurred.length; index += 1) {
    blurred[index] = (blurred[index] ?? 0) / maximum;
  }
  return blurred;
}

function resizeBilinearMask(options: {
  mask: Uint8Array;
  width: number;
  height: number;
  x1: number;
  y1: number;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}): Float32Array {
  const output = new Float32Array(options.targetWidth * options.targetHeight);
  for (let y = 0; y < options.targetHeight; y += 1) {
    const sourceY =
      options.y1 +
      ((y + 0.5) * options.sourceHeight) / options.targetHeight -
      0.5;
    const y0 = clamp(
      Math.floor(sourceY),
      options.y1,
      options.y1 + options.sourceHeight - 1,
    );
    const y1 = clamp(y0 + 1, options.y1, options.y1 + options.sourceHeight - 1);
    const yWeight = Math.max(0, Math.min(1, sourceY - Math.floor(sourceY)));
    for (let x = 0; x < options.targetWidth; x += 1) {
      const sourceX =
        options.x1 +
        ((x + 0.5) * options.sourceWidth) / options.targetWidth -
        0.5;
      const x0 = clamp(
        Math.floor(sourceX),
        options.x1,
        options.x1 + options.sourceWidth - 1,
      );
      const x1 = clamp(
        x0 + 1,
        options.x1,
        options.x1 + options.sourceWidth - 1,
      );
      const xWeight = Math.max(0, Math.min(1, sourceX - Math.floor(sourceX)));
      const top =
        (options.mask[y0 * options.width + x0] ?? 0) * (1 - xWeight) +
        (options.mask[y0 * options.width + x1] ?? 0) * xWeight;
      const bottom =
        (options.mask[y1 * options.width + x0] ?? 0) * (1 - xWeight) +
        (options.mask[y1 * options.width + x1] ?? 0) * xWeight;
      output[y * options.targetWidth + x] =
        top * (1 - yWeight) + bottom * yWeight;
    }
  }
  return output;
}

function gaussianBlur3(values: Float32Array, width: number): Float32Array {
  const sigma = 0.55;
  const edge = Math.exp(-1 / (2 * sigma * sigma));
  const denominator = 1 + edge * 2;
  const weights = [edge / denominator, 1 / denominator, edge / denominator];
  const horizontal = new Float32Array(values.length);
  const output = new Float32Array(values.length);
  const height = values.length / width;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] =
        (values[y * width + reflect(x - 1, width)] ?? 0) * (weights[0] ?? 0) +
        (values[y * width + x] ?? 0) * (weights[1] ?? 0) +
        (values[y * width + reflect(x + 1, width)] ?? 0) * (weights[2] ?? 0);
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      output[y * width + x] =
        (horizontal[reflect(y - 1, height) * width + x] ?? 0) *
          (weights[0] ?? 0) +
        (horizontal[y * width + x] ?? 0) * (weights[1] ?? 0) +
        (horizontal[reflect(y + 1, height) * width + x] ?? 0) *
          (weights[2] ?? 0);
    }
  }
  return output;
}

function reflect(value: number, size: number): number {
  if (size <= 1) return 0;
  if (value < 0) return -value;
  return value >= size ? size * 2 - value - 2 : value;
}

function darkOtsuMask(image: GrayImage): BinaryImage {
  const histogram = new Uint32Array(256);
  for (const value of image.data) histogram[value] += 1;
  const threshold = otsuThreshold(histogram, image.data.length);
  const data = new Uint8Array(image.data.length);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = (image.data[index] ?? 0) <= threshold ? 1 : 0;
  }
  return { width: image.width, height: image.height, data };
}

function otsuThreshold(histogram: Uint32Array, total: number): number {
  let sum = 0;
  for (let index = 0; index < 256; index += 1) {
    sum += index * (histogram[index] ?? 0);
  }
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let maximumVariance = -1;
  let selected = 0;
  for (let index = 0; index < 256; index += 1) {
    const count = histogram[index] ?? 0;
    backgroundWeight += count;
    if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundSum += index * count;
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const difference = backgroundMean - foregroundMean;
    const variance =
      backgroundWeight * foregroundWeight * difference * difference;
    if (variance > maximumVariance) {
      maximumVariance = variance;
      selected = index;
    }
  }
  return selected;
}

function cropNormalizedBbox(
  page: FontMatchingRasterPage,
  bbox: BBox,
  padding: number,
): GrayImage | null {
  return cropPageGrayscale(page, {
    x1: Math.floor((bbox.x / 1000) * page.width) - padding,
    y1: Math.floor((bbox.y / 1000) * page.height) - padding,
    x2: Math.ceil(((bbox.x + bbox.w) / 1000) * page.width) + padding,
    y2: Math.ceil(((bbox.y + bbox.h) / 1000) * page.height) + padding,
  });
}

function cropPageGrayscale(
  page: FontMatchingRasterPage,
  rect: { x1: number; y1: number; x2: number; y2: number },
): GrayImage | null {
  const x1 = clamp(rect.x1, 0, page.width - 1);
  const y1 = clamp(rect.y1, 0, page.height - 1);
  const x2 = clamp(rect.x2, x1 + 1, page.width);
  const y2 = clamp(rect.y2, y1 + 1, page.height);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width < 2 || height < 2) return null;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = ((y1 + y) * page.width + x1 + x) * 4;
      const blue = page.bgra[source] ?? 0;
      const green = page.bgra[source + 1] ?? 0;
      const red = page.bgra[source + 2] ?? 0;
      data[y * width + x] =
        (red * 9_798 + green * 19_235 + blue * 3_735 + 16_384) >> 15;
    }
  }
  return { width, height, data };
}

function closeMask(image: BinaryImage): BinaryImage {
  return {
    width: image.width,
    height: image.height,
    data: erode(
      dilate(image.data, image.width, image.height),
      image.width,
      image.height,
    ),
  };
}

function dilate(mask: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(mask.length);
  const offsets = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      output[y * width + x] = offsets.some(
        ([dx, dy]) =>
          x + dx >= 0 &&
          x + dx < width &&
          y + dy >= 0 &&
          y + dy < height &&
          Boolean(mask[(y + dy) * width + x + dx]),
      )
        ? 1
        : 0;
    }
  }
  return output;
}

function erode(mask: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(mask.length);
  const offsets = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      output[y * width + x] = offsets.every(
        ([dx, dy]) =>
          x + dx >= 0 &&
          x + dx < width &&
          y + dy >= 0 &&
          y + dy < height &&
          Boolean(mask[(y + dy) * width + x + dx]),
      )
        ? 1
        : 0;
    }
  }
  return output;
}

function connectedComponents(image: BinaryImage): Component[] {
  const seen = new Uint8Array(image.data.length);
  const queue = new Int32Array(image.data.length);
  const output: Component[] = [];
  for (let origin = 0; origin < image.data.length; origin += 1) {
    if (!image.data[origin] || seen[origin]) continue;
    let head = 0;
    let tail = 1;
    let x1 = image.width;
    let y1 = image.height;
    let x2 = 0;
    let y2 = 0;
    queue[0] = origin;
    seen[origin] = 1;
    while (head < tail) {
      const pixel = queue[head++] ?? 0;
      const x = pixel % image.width;
      const y = Math.floor(pixel / image.width);
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x + 1);
      y2 = Math.max(y2, y + 1);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= image.width || ny < 0 || ny >= image.height)
            continue;
          const neighbor = ny * image.width + nx;
          if (!image.data[neighbor] || seen[neighbor]) continue;
          seen[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
    }
    output.push({ area: tail, x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  }
  return output;
}

function cropBinary(image: BinaryImage, component: Component): BinaryImage {
  const data = new Uint8Array(component.width * component.height);
  for (let y = 0; y < component.height; y += 1) {
    for (let x = 0; x < component.width; x += 1) {
      data[y * component.width + x] =
        image.data[(component.y + y) * image.width + component.x + x] ?? 0;
    }
  }
  return { width: component.width, height: component.height, data };
}

function touchesEdge(component: Component, image: BinaryImage): boolean {
  return (
    component.x <= 0 ||
    component.y <= 0 ||
    component.x + component.width >= image.width ||
    component.y + component.height >= image.height
  );
}

function selectEvenly<T>(values: readonly T[], maximum: number): T[] {
  if (values.length <= maximum) return [...values];
  return Array.from({ length: maximum }, (_unused, index) => {
    const source = Math.round((index * (values.length - 1)) / (maximum - 1));
    const value = values[source];
    if (value === undefined)
      throw new Error("Glyph sampling inventory drifted.");
    return value;
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
