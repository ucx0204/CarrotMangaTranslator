/* eslint-disable max-lines -- the three-view pixel recipe is kept in one auditable unit */
import type { BBox } from "../../shared/textTypes";

export const FONT_MATCHING_PIXEL_INPUT_SIZE = 224;
export const FONT_MATCHING_PIXEL_VIEW_COUNT = 3;
export const FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION =
  "font-matching-glyph-morphology-v1";

const CONTEXT_PADDING_RATIO = 0.35;
const CONTEXT_PADDING_MIN = 6;
const CONTEXT_PADDING_MAX = 64;
const LANCZOS_RADIUS = 3;

export type FontMatchingRasterPage = Readonly<{
  width: number;
  height: number;
  /** Electron NativeImage `toBitmap()` bytes in BGRA order. */
  bgra: Uint8Array;
}>;

export type PreparedFontMatchingBlockViews = Readonly<{
  /** raw_224, context_224, glyph_224; each view is normalized RGB CHW. */
  pixelValues: Float32Array;
  /** Deterministic raw-crop glyph geometry; no OCR text or semantic input. */
  glyphMorphology: FontMatchingGlyphMorphologyV1;
}>;

export type FontMatchingGlyphMorphologyV1 = Readonly<{
  contractVersion: typeof FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION;
  maskSource: "raw_grayscale_otsu_minority_area3";
  distanceTransform: "opencv_dist_l2_mask5";
  connectivity: 8;
  maskWidth: number;
  maskHeight: number;
  otsuThreshold: number;
  foregroundPolarity: "dark" | "light";
  foregroundPixelCount: number;
  connectedComponentCount: number;
  globalForegroundDistanceMean: number;
  medianComponentDistanceMean: number;
  medianComponentFill: number;
  foregroundMeanLuma: number;
  backgroundMeanLuma: number;
}>;

type PixelRect = Readonly<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}>;

type RgbImage = Readonly<{
  width: number;
  height: number;
  data: Uint8Array;
}>;

/**
 * Reproduce the trainer's ordered three-view contract from one original page.
 * Invalid or maskless crops return null so callers can abstain block-locally.
 */
export function prepareFontMatchingBlockViews(
  page: FontMatchingRasterPage,
  bbox: BBox,
  signal?: AbortSignal,
): PreparedFontMatchingBlockViews | null {
  assertRaster(page);
  throwIfAborted(signal);
  const rawRect = normalizedBboxToPixels(bbox, page.width, page.height);
  if (!rawRect) return null;
  const raw = cropBgraToRgb(page, rawRect);
  const glyphMask = extractForegroundMask(raw, signal);
  const tightLocal = glyphMask ? maskBounds(glyphMask, raw.width) : null;
  if (!glyphMask || !tightLocal) return null;
  const glyphMorphology = buildGlyphMorphology(raw, signal);

  const tightPage = {
    x1: rawRect.x1 + tightLocal.x1,
    y1: rawRect.y1 + tightLocal.y1,
    x2: rawRect.x1 + tightLocal.x2,
    y2: rawRect.y1 + tightLocal.y2,
  };
  const contextRect = expandContextRect(tightPage, page.width, page.height);
  const context = cropBgraToRgb(page, contextRect);
  const glyph = whiteCompositeGlyph(raw, glyphMask, tightLocal);
  const views = [raw, context, glyph];
  const viewSize = 3 * FONT_MATCHING_PIXEL_INPUT_SIZE ** 2;
  const pixelValues = new Float32Array(views.length * viewSize);
  for (const [index, view] of views.entries()) {
    throwIfAborted(signal);
    letterboxToSiglipChw(view, pixelValues, index * viewSize, signal);
  }
  return { pixelValues, glyphMorphology };
}

type ConnectedGlyphComponent = Readonly<{
  label: number;
  area: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}>;

/** Separate source-expression input; the existing three-view recipe is unchanged. */
export function prepareFontMatchingInkComponents(
  page: FontMatchingRasterPage,
  bbox: BBox,
  signal?: AbortSignal,
) {
  assertRaster(page);
  throwIfAborted(signal);
  const rectangle = normalizedBboxToPixels(bbox, page.width, page.height);
  if (!rectangle) return null;
  const image = cropBgraToRgb(page, rectangle);
  const { grayscale, histogram } = buildMorphologyGrayscale(image, signal);
  const { mask, threshold, foregroundPolarity } = buildMorphologyMask(
    grayscale,
    histogram,
  );
  const { labels, components } = cleanAndLabelGlyphComponents(
    mask,
    image.width,
    image.height,
    signal,
  );
  return {
    width: image.width,
    height: image.height,
    labels,
    components,
    threshold,
    foregroundPolarity,
  };
}

/**
 * A separate audit mask is intentional here. The model's glyph view keeps its
 * established color-distance mask, while morphology uses polarity-neutral raw
 * grayscale strokes. This avoids feeding model/semantic outputs back into the
 * veto and preserves the trained three-view input contract.
 */
function buildGlyphMorphology(
  image: RgbImage,
  signal?: AbortSignal,
): FontMatchingGlyphMorphologyV1 {
  const { grayscale, histogram } = buildMorphologyGrayscale(image, signal);
  const { threshold, foregroundPolarity, mask } = buildMorphologyMask(
    grayscale,
    histogram,
  );
  const { labels, components } = cleanAndLabelGlyphComponents(
    mask,
    image.width,
    image.height,
    signal,
  );
  const distances = distanceTransformL2Mask5(
    mask,
    image.width,
    image.height,
    signal,
  );
  const statistics = summarizeGlyphMorphology(
    grayscale,
    mask,
    labels,
    components,
    distances,
  );
  return {
    contractVersion: FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION,
    maskSource: "raw_grayscale_otsu_minority_area3",
    distanceTransform: "opencv_dist_l2_mask5",
    connectivity: 8,
    maskWidth: image.width,
    maskHeight: image.height,
    otsuThreshold: threshold,
    foregroundPolarity,
    ...statistics,
  };
}

function buildMorphologyGrayscale(
  image: RgbImage,
  signal?: AbortSignal,
): Readonly<{ grayscale: Uint8Array; histogram: Uint32Array }> {
  const histogram = new Uint32Array(256);
  const grayscale = new Uint8Array(image.width * image.height);
  for (let pixel = 0; pixel < grayscale.length; pixel += 1) {
    if ((pixel & 0x3fff) === 0) throwIfAborted(signal);
    const offset = pixel * 3;
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    // Canonical OpenCV 4.11 uint8 BGR2GRAY fixed-point coefficients.
    const value = (red * 9_798 + green * 19_235 + blue * 3_735 + 16_384) >> 15;
    grayscale[pixel] = value;
    histogram[value] += 1;
  }
  return { grayscale, histogram };
}

function buildMorphologyMask(
  grayscale: Uint8Array,
  histogram: Uint32Array,
): Readonly<{
  threshold: number;
  foregroundPolarity: "dark" | "light";
  mask: Uint8Array;
}> {
  const threshold = opencvOtsuThreshold(histogram);
  let darkCount = 0;
  for (const value of grayscale) {
    if (value <= threshold) darkCount += 1;
  }
  const foregroundPolarity =
    darkCount <= grayscale.length - darkCount ? "dark" : "light";
  const mask = new Uint8Array(grayscale.length);
  for (let pixel = 0; pixel < grayscale.length; pixel += 1) {
    const dark = (grayscale[pixel] ?? 0) <= threshold;
    mask[pixel] = dark === (foregroundPolarity === "dark") ? 1 : 0;
  }
  return { threshold, foregroundPolarity, mask };
}

function summarizeGlyphMorphology(
  grayscale: Uint8Array,
  mask: Uint8Array,
  labels: Int32Array,
  components: readonly ConnectedGlyphComponent[],
  distances: Float32Array,
): Pick<
  FontMatchingGlyphMorphologyV1,
  | "foregroundPixelCount"
  | "connectedComponentCount"
  | "globalForegroundDistanceMean"
  | "medianComponentDistanceMean"
  | "medianComponentFill"
  | "foregroundMeanLuma"
  | "backgroundMeanLuma"
> {
  const componentDistanceSums = new Float64Array(components.length + 1);
  let foregroundDistanceSum = 0;
  let foregroundPixelCount = 0;
  let foregroundLumaSum = 0;
  let backgroundLumaSum = 0;
  let backgroundPixelCount = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) {
      backgroundLumaSum += grayscale[pixel] ?? 0;
      backgroundPixelCount += 1;
      continue;
    }
    const distance = distances[pixel] ?? 0;
    foregroundDistanceSum += distance;
    foregroundLumaSum += grayscale[pixel] ?? 0;
    foregroundPixelCount += 1;
    componentDistanceSums[labels[pixel] ?? 0] += distance;
  }
  const componentDistanceMeans = components.map(
    ({ label, area }) => (componentDistanceSums[label] ?? 0) / area,
  );
  const componentFills = components.map(
    ({ area, x1, y1, x2, y2 }) => area / ((x2 - x1) * (y2 - y1)),
  );
  return {
    foregroundPixelCount,
    connectedComponentCount: components.length,
    globalForegroundDistanceMean: meanOrZero(
      foregroundDistanceSum,
      foregroundPixelCount,
    ),
    medianComponentDistanceMean: median(componentDistanceMeans),
    medianComponentFill: median(componentFills),
    foregroundMeanLuma: meanOrZero(foregroundLumaSum, foregroundPixelCount),
    backgroundMeanLuma: meanOrZero(backgroundLumaSum, backgroundPixelCount),
  };
}

function meanOrZero(sum: number, count: number): number {
  return count > 0 ? sum / count : 0;
}

/** Canonical scalar OpenCV Otsu loop, including its float-epsilon gates. */
function opencvOtsuThreshold(histogram: Uint32Array): number {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total <= 0) return 0;
  const scale = 1 / total;
  let globalMean = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    globalMean += index * (histogram[index] ?? 0);
  }
  globalMean *= scale;
  let firstWeight = 0;
  let firstMean = 0;
  let maximumVariance = 0;
  let selected = 0;
  const floatEpsilon = 1.1920928955078125e-7;
  for (let index = 0; index < histogram.length; index += 1) {
    const probability = (histogram[index] ?? 0) * scale;
    firstMean *= firstWeight;
    firstWeight += probability;
    const secondWeight = 1 - firstWeight;
    if (
      Math.min(firstWeight, secondWeight) < floatEpsilon ||
      Math.max(firstWeight, secondWeight) > 1 - floatEpsilon
    ) {
      continue;
    }
    firstMean = (firstMean + index * probability) / firstWeight;
    const secondMean = (globalMean - firstWeight * firstMean) / secondWeight;
    const difference = firstMean - secondMean;
    const variance = firstWeight * secondWeight * difference * difference;
    if (variance > maximumVariance) {
      maximumVariance = variance;
      selected = index;
    }
  }
  return selected;
}

function cleanAndLabelGlyphComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  signal?: AbortSignal,
): {
  labels: Int32Array;
  components: ConnectedGlyphComponent[];
} {
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: ConnectedGlyphComponent[] = [];
  let nextLabel = 1;
  for (let origin = 0; origin < mask.length; origin += 1) {
    if (!mask[origin] || labels[origin]) continue;
    throwIfAborted(signal);
    let head = 0;
    let tail = 1;
    let x1 = width;
    let y1 = height;
    let x2 = 0;
    let y2 = 0;
    queue[0] = origin;
    labels[origin] = nextLabel;
    while (head < tail) {
      const pixel = queue[head++] ?? 0;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x + 1);
      y2 = Math.max(y2, y + 1);
      tail = enqueueEightConnectedGlyphNeighbors({
        mask,
        labels,
        queue,
        tail,
        label: nextLabel,
        width,
        height,
        x,
        y,
      });
    }
    if (tail < 3) {
      for (let index = 0; index < tail; index += 1) {
        const pixel = queue[index] ?? 0;
        mask[pixel] = 0;
        labels[pixel] = 0;
      }
      continue;
    }
    components.push({
      label: nextLabel,
      area: tail,
      x1,
      y1,
      x2,
      y2,
    });
    nextLabel += 1;
  }
  return { labels, components };
}

function enqueueEightConnectedGlyphNeighbors(options: {
  mask: Uint8Array;
  labels: Int32Array;
  queue: Int32Array;
  tail: number;
  label: number;
  width: number;
  height: number;
  x: number;
  y: number;
}): number {
  let { tail } = options;
  for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      if (xOffset === 0 && yOffset === 0) continue;
      const neighborX = options.x + xOffset;
      const neighborY = options.y + yOffset;
      if (
        !isInsideRaster(neighborX, neighborY, options.width, options.height)
      ) {
        continue;
      }
      const neighbor = neighborY * options.width + neighborX;
      if (!options.mask[neighbor] || options.labels[neighbor]) continue;
      options.labels[neighbor] = options.label;
      options.queue[tail++] = neighbor;
    }
  }
  return tail;
}

function isInsideRaster(
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  return x >= 0 && x < width && y >= 0 && y < height;
}

type ChamferOffset = readonly [x: number, y: number, weight: number];

const CHAMFER_AXIS = 1;
const CHAMFER_DIAGONAL = Math.fround(1.4);
const CHAMFER_KNIGHT = Math.fround(2.1969);
const CHAMFER_FORWARD: readonly ChamferOffset[] = [
  [-1, -2, CHAMFER_KNIGHT],
  [1, -2, CHAMFER_KNIGHT],
  [-2, -1, CHAMFER_KNIGHT],
  [-1, -1, CHAMFER_DIAGONAL],
  [0, -1, CHAMFER_AXIS],
  [1, -1, CHAMFER_DIAGONAL],
  [2, -1, CHAMFER_KNIGHT],
  [-1, 0, CHAMFER_AXIS],
];
const CHAMFER_BACKWARD: readonly ChamferOffset[] = [
  [1, 0, CHAMFER_AXIS],
  [-2, 1, CHAMFER_KNIGHT],
  [-1, 1, CHAMFER_DIAGONAL],
  [0, 1, CHAMFER_AXIS],
  [1, 1, CHAMFER_DIAGONAL],
  [2, 1, CHAMFER_KNIGHT],
  [-1, 2, CHAMFER_KNIGHT],
  [1, 2, CHAMFER_KNIGHT],
];

/** OpenCV DIST_L2/DIST_MASK_5's two-pass float32 chamfer transform. */
function distanceTransformL2Mask5(
  mask: Uint8Array,
  width: number,
  height: number,
  signal?: AbortSignal,
): Float32Array {
  const distances = new Float32Array(mask.length);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    distances[pixel] = mask[pixel] ? 3.4028234663852886e38 : 0;
  }
  for (let y = 0; y < height; y += 1) {
    if ((y & 0x3f) === 0) throwIfAborted(signal);
    for (let x = 0; x < width; x += 1) {
      relaxChamferPixel(distances, width, height, x, y, CHAMFER_FORWARD);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    if ((y & 0x3f) === 0) throwIfAborted(signal);
    for (let x = width - 1; x >= 0; x -= 1) {
      relaxChamferPixel(distances, width, height, x, y, CHAMFER_BACKWARD);
    }
  }
  return distances;
}

function relaxChamferPixel(
  distances: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  offsets: readonly ChamferOffset[],
): void {
  const pixel = y * width + x;
  let best = distances[pixel] ?? 0;
  if (best === 0) return;
  for (const [xOffset, yOffset, weight] of offsets) {
    const neighborX = x + xOffset;
    const neighborY = y + yOffset;
    if (
      neighborX < 0 ||
      neighborX >= width ||
      neighborY < 0 ||
      neighborY >= height
    ) {
      continue;
    }
    const candidate = Math.fround(
      (distances[neighborY * width + neighborX] ?? 0) + weight,
    );
    if (candidate < best) best = candidate;
  }
  distances[pixel] = best;
}

function assertRaster(page: FontMatchingRasterPage): void {
  if (
    !Number.isInteger(page.width) ||
    !Number.isInteger(page.height) ||
    page.width <= 0 ||
    page.height <= 0 ||
    page.bgra.byteLength < page.width * page.height * 4
  ) {
    throw new Error("Font matching received an invalid original-page raster.");
  }
}

function normalizedBboxToPixels(
  bbox: BBox,
  width: number,
  height: number,
): PixelRect | null {
  const values = [bbox.x, bbox.y, bbox.w, bbox.h];
  if (values.some((value) => !Number.isFinite(value))) return null;
  const x1 = clampInteger(Math.floor((bbox.x / 1000) * width), 0, width - 1);
  const y1 = clampInteger(Math.floor((bbox.y / 1000) * height), 0, height - 1);
  const x2 = clampInteger(
    Math.ceil(((bbox.x + bbox.w) / 1000) * width),
    x1 + 1,
    width,
  );
  const y2 = clampInteger(
    Math.ceil(((bbox.y + bbox.h) / 1000) * height),
    y1 + 1,
    height,
  );
  return x2 - x1 >= 2 && y2 - y1 >= 2 ? { x1, y1, x2, y2 } : null;
}

function cropBgraToRgb(
  page: FontMatchingRasterPage,
  rect: PixelRect,
): RgbImage {
  const width = rect.x2 - rect.x1;
  const height = rect.y2 - rect.y1;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = ((rect.y1 + y) * page.width + rect.x1 + x) * 4;
      const target = (y * width + x) * 3;
      data[target] = page.bgra[source + 2] ?? 0;
      data[target + 1] = page.bgra[source + 1] ?? 0;
      data[target + 2] = page.bgra[source] ?? 0;
    }
  }
  return { width, height, data };
}

function extractForegroundMask(
  image: RgbImage,
  signal?: AbortSignal,
): Uint8Array | null {
  const background = medianBorderColor(image);
  const histogram = new Uint32Array(256);
  const distances = new Uint8Array(image.width * image.height);
  for (let pixel = 0; pixel < distances.length; pixel += 1) {
    if ((pixel & 0x3fff) === 0) throwIfAborted(signal);
    const offset = pixel * 3;
    const red = (image.data[offset] ?? 0) - background[0];
    const green = (image.data[offset + 1] ?? 0) - background[1];
    const blue = (image.data[offset + 2] ?? 0) - background[2];
    const bucket = clampInteger(
      Math.round(
        (Math.hypot(red, green, blue) / Math.sqrt(3 * 255 ** 2)) * 255,
      ),
      0,
      255,
    );
    distances[pixel] = bucket;
    histogram[bucket] += 1;
  }
  const threshold = Math.max(10, otsuThreshold(histogram));
  const mask = new Uint8Array(distances.length);
  let selected = 0;
  for (let pixel = 0; pixel < distances.length; pixel += 1) {
    if ((distances[pixel] ?? 0) >= threshold) {
      mask[pixel] = 1;
      selected += 1;
    }
  }
  const ratio = selected / Math.max(1, mask.length);
  if (ratio < 0.003 || ratio > 0.78) return null;
  removeEnclosingBorderComponents(mask, image.width, image.height, signal);
  const remaining = mask.reduce((total, value) => total + value, 0);
  return remaining / mask.length >= 0.002 ? mask : null;
}

function medianBorderColor(image: RgbImage): readonly [number, number, number] {
  const channels = [[], [], []] as [number[], number[], number[]];
  const add = (x: number, y: number): void => {
    const offset = (y * image.width + x) * 3;
    channels[0].push(image.data[offset] ?? 0);
    channels[1].push(image.data[offset + 1] ?? 0);
    channels[2].push(image.data[offset + 2] ?? 0);
  };
  for (let x = 0; x < image.width; x += 1) {
    add(x, 0);
    if (image.height > 1) add(x, image.height - 1);
  }
  for (let y = 1; y + 1 < image.height; y += 1) {
    add(0, y);
    if (image.width > 1) add(image.width - 1, y);
  }
  return [median(channels[0]), median(channels[1]), median(channels[2])];
}

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? (values[middle] ?? 0)
    : ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
}

function otsuThreshold(histogram: Uint32Array): number {
  let total = 0;
  let sum = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    const count = histogram[index] ?? 0;
    total += count;
    sum += index * count;
  }
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let maximumVariance = -1;
  let selected = 0;
  for (let threshold = 0; threshold < 255; threshold += 1) {
    const count = histogram[threshold] ?? 0;
    backgroundWeight += count;
    if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundSum += threshold * count;
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance =
      backgroundWeight *
      foregroundWeight *
      (backgroundMean - foregroundMean) ** 2;
    if (variance > maximumVariance) {
      maximumVariance = variance;
      selected = threshold;
    }
  }
  return selected;
}

// eslint-disable-next-line complexity -- edge/component states are one bounded flood fill
function removeEnclosingBorderComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  signal?: AbortSignal,
): void {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  for (let origin = 0; origin < mask.length; origin += 1) {
    if (!mask[origin] || visited[origin]) continue;
    throwIfAborted(signal);
    let head = 0;
    let tail = 1;
    let edgeMask = 0;
    queue[0] = origin;
    visited[origin] = 1;
    while (head < tail) {
      const pixel = queue[head++] ?? 0;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      if (x === 0) edgeMask |= 1;
      if (x === width - 1) edgeMask |= 2;
      if (y === 0) edgeMask |= 4;
      if (y === height - 1) edgeMask |= 8;
      enqueueNeighbor(pixel - 1, x > 0);
      enqueueNeighbor(pixel + 1, x + 1 < width);
      enqueueNeighbor(pixel - width, y > 0);
      enqueueNeighbor(pixel + width, y + 1 < height);
    }
    const edgeCount = popcount4(edgeMask);
    if (edgeCount >= 3 && tail / mask.length > 0.08) {
      for (let index = 0; index < tail; index += 1) {
        mask[queue[index] ?? 0] = 0;
      }
    }

    function enqueueNeighbor(pixel: number, allowed: boolean): void {
      if (!allowed || !mask[pixel] || visited[pixel]) return;
      visited[pixel] = 1;
      queue[tail++] = pixel;
    }
  }
}

function popcount4(value: number): number {
  return (
    (value & 1 ? 1 : 0) +
    (value & 2 ? 1 : 0) +
    (value & 4 ? 1 : 0) +
    (value & 8 ? 1 : 0)
  );
}

function maskBounds(mask: Uint8Array, width: number): PixelRect | null {
  let x1 = width;
  let y1 = Math.ceil(mask.length / width);
  let x2 = 0;
  let y2 = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x + 1);
    y2 = Math.max(y2, y + 1);
  }
  return x2 > x1 && y2 > y1 ? { x1, y1, x2, y2 } : null;
}

function expandContextRect(
  rect: PixelRect,
  pageWidth: number,
  pageHeight: number,
): PixelRect {
  const padding = Math.min(
    CONTEXT_PADDING_MAX,
    Math.max(
      CONTEXT_PADDING_MIN,
      Math.round(
        Math.max(rect.x2 - rect.x1, rect.y2 - rect.y1) * CONTEXT_PADDING_RATIO,
      ),
    ),
  );
  return {
    x1: Math.max(0, rect.x1 - padding),
    y1: Math.max(0, rect.y1 - padding),
    x2: Math.min(pageWidth, rect.x2 + padding),
    y2: Math.min(pageHeight, rect.y2 + padding),
  };
}

function whiteCompositeGlyph(
  raw: RgbImage,
  mask: Uint8Array,
  bounds: PixelRect,
): RgbImage {
  const width = bounds.x2 - bounds.x1;
  const height = bounds.y2 - bounds.y1;
  const data = new Uint8Array(width * height * 3);
  data.fill(255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourcePixel = (bounds.y1 + y) * raw.width + bounds.x1 + x;
      if (!mask[sourcePixel]) continue;
      const source = sourcePixel * 3;
      const target = (y * width + x) * 3;
      data[target] = raw.data[source] ?? 255;
      data[target + 1] = raw.data[source + 1] ?? 255;
      data[target + 2] = raw.data[source + 2] ?? 255;
    }
  }
  return { width, height, data };
}

function letterboxToSiglipChw(
  image: RgbImage,
  output: Float32Array,
  outputOffset: number,
  signal?: AbortSignal,
): void {
  const scale = Math.min(
    FONT_MATCHING_PIXEL_INPUT_SIZE / image.width,
    FONT_MATCHING_PIXEL_INPUT_SIZE / image.height,
  );
  const targetWidth = Math.max(1, pythonRound(image.width * scale));
  const targetHeight = Math.max(1, pythonRound(image.height * scale));
  const resized = resizeLanczosRgb(image, targetWidth, targetHeight, signal);
  const xOffset = Math.floor(
    (FONT_MATCHING_PIXEL_INPUT_SIZE - targetWidth) / 2,
  );
  const yOffset = Math.floor(
    (FONT_MATCHING_PIXEL_INPUT_SIZE - targetHeight) / 2,
  );
  const plane = FONT_MATCHING_PIXEL_INPUT_SIZE ** 2;
  output.fill(1, outputOffset, outputOffset + plane * 3);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const source = (y * targetWidth + x) * 3;
      const target =
        (y + yOffset) * FONT_MATCHING_PIXEL_INPUT_SIZE + x + xOffset;
      output[outputOffset + target] = normalizeSiglip(resized[source] ?? 255);
      output[outputOffset + plane + target] = normalizeSiglip(
        resized[source + 1] ?? 255,
      );
      output[outputOffset + plane * 2 + target] = normalizeSiglip(
        resized[source + 2] ?? 255,
      );
    }
  }
}

// eslint-disable-next-line complexity -- separable RGB resampling shares one bounded loop
function resizeLanczosRgb(
  image: RgbImage,
  targetWidth: number,
  targetHeight: number,
  signal?: AbortSignal,
): Float32Array {
  if (image.width === targetWidth && image.height === targetHeight) {
    return Float32Array.from(image.data);
  }
  const horizontal = new Float32Array(targetWidth * image.height * 3);
  const horizontalWeights = buildResampleWeights(image.width, targetWidth);
  for (let y = 0; y < image.height; y += 1) {
    if ((y & 0x1f) === 0) throwIfAborted(signal);
    for (let x = 0; x < targetWidth; x += 1) {
      const weights = horizontalWeights[x] ?? [];
      const target = (y * targetWidth + x) * 3;
      for (const { index, weight } of weights) {
        const source = (y * image.width + index) * 3;
        horizontal[target] += (image.data[source] ?? 0) * weight;
        horizontal[target + 1] += (image.data[source + 1] ?? 0) * weight;
        horizontal[target + 2] += (image.data[source + 2] ?? 0) * weight;
      }
    }
  }
  const output = new Float32Array(targetWidth * targetHeight * 3);
  const verticalWeights = buildResampleWeights(image.height, targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    throwIfAborted(signal);
    const weights = verticalWeights[y] ?? [];
    for (let x = 0; x < targetWidth; x += 1) {
      const target = (y * targetWidth + x) * 3;
      for (const { index, weight } of weights) {
        const source = (index * targetWidth + x) * 3;
        output[target] += horizontal[source] * weight;
        output[target + 1] += horizontal[source + 1] * weight;
        output[target + 2] += horizontal[source + 2] * weight;
      }
    }
  }
  return output;
}

type ResampleWeight = Readonly<{ index: number; weight: number }>;

function buildResampleWeights(
  sourceSize: number,
  targetSize: number,
): ResampleWeight[][] {
  const scale = sourceSize / targetSize;
  const filterScale = Math.max(1, scale);
  const support = LANCZOS_RADIUS * filterScale;
  return Array.from({ length: targetSize }, (_unused, target) => {
    const center = (target + 0.5) * scale - 0.5;
    const start = Math.ceil(center - support);
    const end = Math.floor(center + support);
    const accumulated = new Map<number, number>();
    for (let source = start; source <= end; source += 1) {
      const clamped = clampInteger(source, 0, sourceSize - 1);
      const weight = lanczos((center - source) / filterScale);
      accumulated.set(clamped, (accumulated.get(clamped) ?? 0) + weight);
    }
    const total = [...accumulated.values()].reduce(
      (sum, weight) => sum + weight,
      0,
    );
    return [...accumulated].map(([index, weight]) => ({
      index,
      weight: total === 0 ? 0 : weight / total,
    }));
  });
}

function lanczos(value: number): number {
  const absolute = Math.abs(value);
  if (absolute < Number.EPSILON) return 1;
  if (absolute >= LANCZOS_RADIUS) return 0;
  const piValue = Math.PI * value;
  return (
    (Math.sin(piValue) / piValue) *
    (Math.sin(piValue / LANCZOS_RADIUS) / (piValue / LANCZOS_RADIUS))
  );
}

function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (Math.abs(fraction - 0.5) <= Number.EPSILON * Math.max(1, value)) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(value);
}

function normalizeSiglip(value: number): number {
  return Math.max(-1, Math.min(1, value / 127.5 - 1));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
