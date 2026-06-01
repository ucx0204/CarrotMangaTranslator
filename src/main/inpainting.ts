import { nativeImage } from "electron";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { clamp } from "../shared/geometry";
import type { InpaintingMaskStroke, InpaintingPoint, MangaPage, TranslationBlock } from "../shared/types";
import {
  ensureMgtFluxKleinRuntime,
  ensureRemoteFile,
  FLUX_MODEL_FILE,
  FLUX_MODEL_REPO,
  FLUX_VAE_FILE,
  FLUX_VAE_REPO,
  hfResolveUrl
} from "./inpainting/fluxAssets";
import { FluxWorker } from "./inpainting/fluxWorker";
import {
  alignRectToMultiple,
  bboxToPixelRect,
  expandRect,
  hasUsableBbox,
  mergeFilledRectIntoPage,
  mergeMaskIntoPage,
  mergeRects,
  rectHasMask,
  resolveFluxProcessSize,
  resolvePatternBlockMarginPx,
  resolvePatternDilationRadius,
  resolvePatternRegionPaddingPx,
  resolvePatternWindowMarginPx,
  type PixelRect
} from "./inpainting/maskGeometry";
import {
  buildLocalMask,
  compositeFluxOutput,
  cropBitmapFromPage,
  maskBoundsInRect,
  readGeneratedBitmap,
  writePngFromBitmap,
  writePngFromMask
} from "./inpainting/imageRaster";

const FLUX_INPAINT_CONTEXT_PX = 160;
const FLUX_INPAINT_MASK_PADDING_PX = 16;
const FLUX_INPAINT_FEATHER_PX = 8;
const FLUX_INPAINT_MAX_PIXELS = 1024 * 1024;
const FLUX_INPAINT_MULTIPLE = 16;

type Rgb = {
  r: number;
  g: number;
  b: number;
};

export type InpaintingRuntimeProgress = {
  progressText: string;
  detail?: string;
  progressMode?: "determinate" | "indeterminate" | "log-only";
  progressPercent?: number;
  progressBytes?: number;
  progressTotalBytes?: number;
  installLogLine?: string;
};

export type FluxInpaintingEngine = {
  runtimePath: string;
  modelPath: string;
  vaePath: string;
  inpaint: (
    bitmap: Buffer,
    width: number,
    height: number,
    mask: Uint8Array,
    windows: PixelRect[],
    options?: {
      signal?: AbortSignal;
      featherPx?: number;
      contextPx?: number;
      maskPaddingPx?: number;
      maxPixels?: number;
    }
  ) => Promise<void>;
  dispose: () => Promise<void>;
};

export type PatternPageInpaintingResult = {
  page: MangaPage;
  blocksErased: number;
};

export type ImageDecodeFallback = (filePath: string) => Promise<Buffer | null>;

export async function inpaintPatternPage(
  page: MangaPage,
  options: {
    signal?: AbortSignal;
    decodeFallback?: ImageDecodeFallback;
    fluxEngine?: FluxInpaintingEngine;
  } = {}
): Promise<PatternPageInpaintingResult> {
  const patternBlocks = page.blocks.filter((block) => hasUsableBbox(block.bbox) && !block.inpaintExcluded);
  if (patternBlocks.length === 0) {
    return { page, blocksErased: 0 };
  }

  const image = await loadPageImage(page.inpaintedImagePath ?? page.imagePath, options.decodeFallback);
  const size = image.getSize();
  if (!size.width || !size.height) {
    throw new Error(`페이지 이미지를 읽지 못했습니다: ${page.name}`);
  }

  const bitmap = Buffer.from(image.toBitmap());
  if (bitmap.length < size.width * size.height * 4) {
    throw new Error(`페이지 이미지 비트맵을 만들지 못했습니다: ${page.name}`);
  }

  const pageMask = new Uint8Array(size.width * size.height);
  const inpaintWindows: PixelRect[] = [];
  let blocksErased = 0;

  for (const block of patternBlocks) {
    throwIfAborted(options.signal);
    const sourceRect = bboxToPixelRect(block.bbox, page);
    const supportRect = expandRect(sourceRect, size.width, size.height, resolvePatternRegionPaddingPx(block, page));
    const detectRect = expandRect(sourceRect, size.width, size.height, resolvePatternBlockMarginPx(block, page));
    const detectedMask = buildPatternTextMask(bitmap, size.width, size.height, detectRect, resolvePatternDilationRadius(block));

    // Koharu's Flux path intentionally widens a detected text mask to the whole
    // text-region support. Thin glyph-only masks tend to leave residue on tones
    // and SFX, so pattern cleanup uses the block region as the inference mask.
    mergeFilledRectIntoPage(pageMask, size.width, supportRect);
    if (detectedMask.count > 0) {
      mergeMaskIntoPage(pageMask, size.width, detectRect, detectedMask.mask);
    }
    inpaintWindows.push(expandRect(supportRect, size.width, size.height, resolvePatternWindowMarginPx(block, page)));
    blocksErased += 1;
  }

  if (blocksErased === 0) {
    return { page, blocksErased: 0 };
  }

  if (!options.fluxEngine) {
    throw new Error("Flux 무늬 배경 인페인팅 엔진이 준비되지 않았습니다.");
  }

  await options.fluxEngine.inpaint(bitmap, size.width, size.height, pageMask, mergeRects(inpaintWindows), {
    signal: options.signal,
    featherPx: FLUX_INPAINT_FEATHER_PX,
    contextPx: FLUX_INPAINT_CONTEXT_PX,
    maskPaddingPx: FLUX_INPAINT_MASK_PADDING_PX,
    maxPixels: FLUX_INPAINT_MAX_PIXELS
  });

  const outputImage = nativeImage.createFromBitmap(bitmap, {
    width: size.width,
    height: size.height
  });
  if (outputImage.isEmpty()) {
    throw new Error(`인페인팅 결과 이미지를 만들지 못했습니다: ${page.name}`);
  }

  const outputPath = resolveInpaintedImagePath(page.imagePath, "pattern");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputImage.toPNG());

  return {
    blocksErased,
    page: {
      ...page,
      inpaintedImagePath: outputPath,
      updatedAt: new Date().toISOString()
    }
  };
}

export async function inpaintDrawnPatternPage(
  page: MangaPage,
  options: {
    strokes: InpaintingMaskStroke[];
    signal?: AbortSignal;
    decodeFallback?: ImageDecodeFallback;
    fluxEngine?: FluxInpaintingEngine;
    featherPx?: number;
  }
): Promise<PatternPageInpaintingResult> {
  const strokes = sanitizeMaskStrokes(options.strokes, page.width, page.height);
  if (strokes.length === 0) {
    return { page, blocksErased: 0 };
  }

  const image = await loadPageImage(page.inpaintedImagePath ?? page.imagePath, options.decodeFallback);
  const size = image.getSize();
  if (!size.width || !size.height) {
    throw new Error(`페이지 이미지를 읽지 못했습니다: ${page.name}`);
  }

  const bitmap = Buffer.from(image.toBitmap());
  if (bitmap.length < size.width * size.height * 4) {
    throw new Error(`페이지 이미지 비트맵을 만들지 못했습니다: ${page.name}`);
  }

  const pageMask = buildMaskFromStrokes(strokes, size.width, size.height);
  const components = maskComponents(pageMask, size.width, size.height, 12)
    .map((component) => expandRect(component.rect, size.width, size.height, FLUX_INPAINT_CONTEXT_PX))
    .filter((rect) => rectHasMask(pageMask, size.width, rect));
  if (components.length === 0) {
    return { page, blocksErased: 0 };
  }

  if (!options.fluxEngine) {
    throw new Error("Flux 무늬 배경 인페인팅 엔진이 준비되지 않았습니다.");
  }

  await options.fluxEngine.inpaint(bitmap, size.width, size.height, pageMask, mergeRects(components), {
    signal: options.signal,
    featherPx: options.featherPx ?? FLUX_INPAINT_FEATHER_PX,
    contextPx: FLUX_INPAINT_CONTEXT_PX,
    maskPaddingPx: FLUX_INPAINT_MASK_PADDING_PX,
    maxPixels: FLUX_INPAINT_MAX_PIXELS
  });

  const outputImage = nativeImage.createFromBitmap(bitmap, {
    width: size.width,
    height: size.height
  });
  if (outputImage.isEmpty()) {
    throw new Error(`인페인팅 결과 이미지를 만들지 못했습니다: ${page.name}`);
  }

  const outputPath = resolveInpaintedImagePath(page.imagePath, "pattern-drawn");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputImage.toPNG());

  return {
    blocksErased: components.length,
    page: {
      ...page,
      inpaintedImagePath: outputPath,
      updatedAt: new Date().toISOString()
    }
  };
}

export async function prepareFluxInpaintingEngine(options: {
  runtimeDir: string;
  modelDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<FluxInpaintingEngine> {
  const runtimePath = await ensureMgtFluxKleinRuntime(options);
  const [modelPath, vaePath] = await Promise.all([
    ensureRemoteFile({
      ...options,
      fileName: FLUX_MODEL_FILE,
      label: "Flux Klein 4B",
      url: hfResolveUrl(FLUX_MODEL_REPO, FLUX_MODEL_FILE)
    }),
    ensureRemoteFile({
      ...options,
      fileName: FLUX_VAE_FILE,
      label: "Flux small decoder",
      url: hfResolveUrl(FLUX_VAE_REPO, FLUX_VAE_FILE)
    })
  ]);

  options.onProgress?.({
    progressText: "Flux 인페인팅 준비 완료",
    detail: "FLUX.2 Klein 4B",
    progressMode: "log-only",
    installLogLine: "Flux 무늬 배경 인페인팅 엔진 준비가 완료되었습니다."
  });

  return createFluxEngine({
    runtimePath,
    modelPath,
    vaePath
  });
}

export async function applyInpaintingRetouch(
  page: MangaPage,
  options: {
    mode: "paint" | "restore";
    points: InpaintingPoint[];
    radiusPx: number;
    color?: string;
    decodeFallback?: ImageDecodeFallback;
  }
): Promise<MangaPage> {
  const points = sanitizePoints(options.points, page.width, page.height);
  if (points.length === 0) {
    return page;
  }

  const baseImage = await loadPageImage(page.inpaintedImagePath ?? page.imagePath, options.decodeFallback);
  const originalImage = await loadPageImage(page.imagePath, options.decodeFallback);
  const size = baseImage.getSize();
  const originalSize = originalImage.getSize();
  if (size.width !== originalSize.width || size.height !== originalSize.height) {
    throw new Error("원본 이미지와 편집 이미지 크기가 다릅니다.");
  }

  const bitmap = Buffer.from(baseImage.toBitmap());
  const originalBitmap = Buffer.from(originalImage.toBitmap());
  const radius = clamp(Math.round(options.radiusPx), 2, 180);
  const paintColor = options.mode === "paint" ? parseHexColor(options.color) : null;

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    for (const point of interpolatePoints(previous, current, Math.max(1, radius * 0.35))) {
      applyRetouchCircle(bitmap, originalBitmap, size.width, size.height, point, radius, options.mode, paintColor);
    }
  }

  const outputImage = nativeImage.createFromBitmap(bitmap, {
    width: size.width,
    height: size.height
  });
  if (outputImage.isEmpty()) {
    throw new Error(`리터치 결과 이미지를 만들지 못했습니다: ${page.name}`);
  }

  const outputPath = resolveInpaintedImagePath(page.imagePath, `retouch-${Date.now().toString(36)}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputImage.toPNG());
  return {
    ...page,
    inpaintedImagePath: outputPath,
    updatedAt: new Date().toISOString()
  };
}

export async function sampleImageColor(
  imagePath: string,
  x: number,
  y: number,
  decodeFallback?: ImageDecodeFallback
): Promise<string> {
  const image = await loadPageImage(imagePath, decodeFallback);
  const size = image.getSize();
  const bitmap = Buffer.from(image.toBitmap());
  const px = clamp(Math.round(x), 0, Math.max(0, size.width - 1));
  const py = clamp(Math.round(y), 0, Math.max(0, size.height - 1));
  return rgbToHex(readRgb(bitmap, size.width, px, py));
}

function createFluxEngine(options: {
  runtimePath: string;
  modelPath: string;
  vaePath: string;
}): FluxInpaintingEngine {
  let worker: FluxWorker | null = null;
  const getWorker = () => {
    worker ??= new FluxWorker(options.runtimePath, options.modelPath, options.vaePath, FLUX_INPAINT_MASK_PADDING_PX);
    return worker;
  };
  return {
    runtimePath: options.runtimePath,
    modelPath: options.modelPath,
    vaePath: options.vaePath,
    async inpaint(bitmap, width, height, mask, windows, runOptions = {}) {
      const featherPx = clamp(Math.round(runOptions.featherPx ?? FLUX_INPAINT_FEATHER_PX), 0, 48);
      const contextPx = clamp(Math.round(runOptions.contextPx ?? FLUX_INPAINT_CONTEXT_PX), 16, 256);
      const maskPaddingPx = clamp(Math.round(runOptions.maskPaddingPx ?? FLUX_INPAINT_MASK_PADDING_PX), 0, 64);
      const maxPixels = clamp(Math.round(runOptions.maxPixels ?? FLUX_INPAINT_MAX_PIXELS), 256 * 256, 1536 * 1536);
      const runDir = join(dirname(options.modelPath), "runs", `flux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      await mkdir(runDir, { recursive: true });
      try {
        for (const [index, window] of windows.entries()) {
          throwIfAborted(runOptions.signal);
          if (!rectHasMask(mask, width, window)) {
            continue;
          }

          const maskBounds = maskBoundsInRect(mask, width, window);
          if (!maskBounds) {
            continue;
          }
          const paddedBounds = alignRectToMultiple(
            expandRect(maskBounds, width, height, contextPx + maskPaddingPx),
            width,
            height,
            FLUX_INPAINT_MULTIPLE
          );
          const localMask = buildLocalMask(mask, width, paddedBounds, 0);
          if (!localMask.some((value) => value > 0)) {
            continue;
          }

          const processSize = resolveFluxProcessSize(paddedBounds.w, paddedBounds.h, maxPixels, FLUX_INPAINT_MULTIPLE);
          const inputPath = join(runDir, `input-${index}.png`);
          const maskPath = join(runDir, `mask-${index}.png`);
          const outputPath = join(runDir, `output-${index}.png`);
          const cropBitmap = cropBitmapFromPage(bitmap, width, paddedBounds);
          await writePngFromBitmap(inputPath, cropBitmap, paddedBounds.w, paddedBounds.h, processSize);
          await writePngFromMask(maskPath, localMask, paddedBounds.w, paddedBounds.h, processSize);

          await getWorker().inpaint(
            {
              input: inputPath,
              mask: maskPath,
              output: outputPath,
              steps: 4,
              strength: 1,
              maxPixels,
              maskPadding: maskPaddingPx
            },
            runOptions.signal
          );
          const generated = await readGeneratedBitmap(outputPath, paddedBounds.w, paddedBounds.h);
          compositeFluxOutput(bitmap, generated, mask, width, paddedBounds, featherPx);
        }
      } finally {
        if (process.env.MGT_KEEP_FLUX_DEBUG !== "1") {
          await rm(runDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
    async dispose() {
      await worker?.dispose();
      worker = null;
    }
  };
}

async function loadPageImage(filePath: string, decodeFallback?: ImageDecodeFallback): Promise<Electron.NativeImage> {
  const direct = nativeImage.createFromPath(filePath);
  if (!direct.isEmpty()) {
    return direct;
  }

  const fallbackBuffer = decodeFallback ? await decodeFallback(filePath) : null;
  if (fallbackBuffer?.length) {
    const fallback = nativeImage.createFromBuffer(fallbackBuffer);
    if (!fallback.isEmpty()) {
      return fallback;
    }
  }

  throw new Error("인페인팅할 이미지를 읽지 못했습니다.");
}

function sanitizeMaskStrokes(strokes: InpaintingMaskStroke[], width: number, height: number): InpaintingMaskStroke[] {
  return strokes
    .map((stroke) => ({
      radiusPx: clamp(Math.round(stroke.radiusPx), 2, 180),
      points: sanitizePoints(stroke.points, width, height)
    }))
    .filter((stroke) => stroke.points.length > 0)
    .slice(0, 200);
}

function buildMaskFromStrokes(strokes: InpaintingMaskStroke[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const stroke of strokes) {
    for (let index = 0; index < stroke.points.length; index += 1) {
      const previous = stroke.points[index - 1] ?? stroke.points[index];
      const current = stroke.points[index];
      for (const point of interpolatePoints(previous, current, Math.max(1, stroke.radiusPx * 0.35))) {
        drawMaskCircle(mask, width, height, point, stroke.radiusPx);
      }
    }
  }
  return mask;
}

function drawMaskCircle(mask: Uint8Array, width: number, height: number, point: InpaintingPoint, radius: number): void {
  const cx = clamp(Math.round(point.x), 0, Math.max(0, width - 1));
  const cy = clamp(Math.round(point.y), 0, Math.max(0, height - 1));
  const x1 = clamp(cx - radius, 0, Math.max(0, width - 1));
  const y1 = clamp(cy - radius, 0, Math.max(0, height - 1));
  const x2 = clamp(cx + radius, x1, Math.max(0, width - 1));
  const y2 = clamp(cy + radius, y1, Math.max(0, height - 1));
  for (let y = y1; y <= y2; y += 1) {
    for (let x = x1; x <= x2; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        mask[y * width + x] = 1;
      }
    }
  }
}

function maskComponents(mask: Uint8Array, width: number, height: number, minArea: number): Array<{ rect: PixelRect; area: number }> {
  const visited = new Uint8Array(mask.length);
  const queue: number[] = [];
  const components: Array<{ rect: PixelRect; area: number }> = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) {
      continue;
    }
    queue.length = 0;
    visited[index] = 1;
    queue.push(index);
    let area = 0;
    let x1 = width;
    let y1 = height;
    let x2 = 0;
    let y2 = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      const x = current % width;
      const y = Math.floor(current / width);
      area += 1;
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x + 1);
      y2 = Math.max(y2, y + 1);
      for (const neighbor of maskNeighbors(x, y, width, height)) {
        if (mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
    if (area >= minArea) {
      components.push({
        area,
        rect: {
          x: x1,
          y: y1,
          w: Math.max(1, x2 - x1),
          h: Math.max(1, y2 - y1)
        }
      });
    }
  }
  return components.sort((left, right) => right.area - left.area);
}

function buildPatternTextMask(
  bitmap: Buffer,
  width: number,
  _height: number,
  rect: PixelRect,
  dilationRadius: number
): { mask: Uint8Array; count: number } {
  const pixelCount = rect.w * rect.h;
  const luminances = new Float32Array(pixelCount);
  const luminanceSamples: number[] = [];
  const redSamples: number[] = [];
  const greenSamples: number[] = [];
  const blueSamples: number[] = [];
  const sampleStep = Math.max(1, Math.floor(Math.max(rect.w, rect.h) / 140));

  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const color = readRgb(bitmap, width, rect.x + x, rect.y + y);
      const lum = luminance(color);
      luminances[y * rect.w + x] = lum;
      if (x % sampleStep === 0 && y % sampleStep === 0) {
        luminanceSamples.push(lum);
        redSamples.push(color.r);
        greenSamples.push(color.g);
        blueSamples.push(color.b);
      }
    }
  }

  if (luminanceSamples.length < 8) {
    return { mask: new Uint8Array(pixelCount), count: 0 };
  }

  const sortedLum = luminanceSamples.sort((left, right) => left - right);
  const p12 = percentile(sortedLum, 0.12);
  const p25 = percentile(sortedLum, 0.25);
  const p50 = percentile(sortedLum, 0.5);
  const p75 = percentile(sortedLum, 0.75);
  const p88 = percentile(sortedLum, 0.88);
  const medianColor = {
    r: median(redSamples),
    g: median(greenSamples),
    b: median(blueSamples)
  };
  const darkCutoff = Math.min(p50 - 18, p25 + 10);
  const brightCutoff = Math.max(p50 + 24, p75 - 6);
  const edgeThreshold = Math.max(18, Math.min(38, (p88 - p12) * 0.2));
  const mask = new Uint8Array(pixelCount);
  let initialCount = 0;

  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const index = y * rect.w + x;
      const lum = luminances[index] ?? 0;
      const color = readRgb(bitmap, width, rect.x + x, rect.y + y);
      const localEdge = localLuminanceEdge(luminances, rect.w, rect.h, x, y);
      const colorOutlier = colorDistance(color, medianColor) >= 34;
      const darkStroke = lum <= darkCutoff;
      const brightStroke = lum >= brightCutoff && localEdge >= edgeThreshold;
      if ((darkStroke || brightStroke) && (localEdge >= edgeThreshold || colorOutlier)) {
        mask[index] = 1;
        initialCount += 1;
      }
    }
  }

  const coverage = initialCount / Math.max(1, pixelCount);
  if (initialCount === 0 || coverage < 0.0015 || coverage > 0.42) {
    return { mask: new Uint8Array(pixelCount), count: 0 };
  }

  const connected = removeTinyMaskComponents(mask, rect.w, rect.h, Math.max(4, Math.round(pixelCount * 0.00035)));
  const dilated = dilateMask(connected.mask, rect.w, rect.h, dilationRadius);
  let count = 0;
  for (const value of dilated) {
    if (value) {
      count += 1;
    }
  }

  const finalCoverage = count / Math.max(1, pixelCount);
  if (connected.count === 0 || finalCoverage > 0.52) {
    return { mask: new Uint8Array(pixelCount), count: 0 };
  }
  return { mask: dilated, count };
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) {
    return mask;
  }
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx * dx + dy * dy > radius * radius) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            output[ny * width + nx] = 1;
          }
        }
      }
    }
  }
  return output;
}

function removeTinyMaskComponents(mask: Uint8Array, width: number, height: number, minArea: number): { mask: Uint8Array; count: number } {
  const output = new Uint8Array(mask.length);
  const visited = new Uint8Array(mask.length);
  const queue: number[] = [];
  let keptCount = 0;

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) {
      continue;
    }

    queue.length = 0;
    const component: number[] = [];
    visited[index] = 1;
    queue.push(index);

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      for (const neighbor of maskNeighbors(x, y, width, height)) {
        if (mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }

    if (component.length >= minArea) {
      for (const pixel of component) {
        output[pixel] = 1;
      }
      keptCount += component.length;
    }
  }

  return { mask: output, count: keptCount };
}

function maskNeighbors(x: number, y: number, width: number, height: number): number[] {
  const neighbors: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        neighbors.push(ny * width + nx);
      }
    }
  }
  return neighbors;
}

function localLuminanceEdge(luminances: Float32Array, width: number, height: number, x: number, y: number): number {
  const center = luminances[y * width + x] ?? 0;
  let maxDiff = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
        continue;
      }
      maxDiff = Math.max(maxDiff, Math.abs(center - (luminances[ny * width + nx] ?? center)));
    }
  }
  return maxDiff;
}

function readRgb(bitmap: Buffer, width: number, x: number, y: number): Rgb {
  const offset = (y * width + x) * 4;
  return {
    b: bitmap[offset] ?? 0,
    g: bitmap[offset + 1] ?? 0,
    r: bitmap[offset + 2] ?? 0
  };
}

function applyRetouchCircle(
  bitmap: Buffer,
  originalBitmap: Buffer,
  width: number,
  height: number,
  point: InpaintingPoint,
  radius: number,
  mode: "paint" | "restore",
  paintColor: Rgb | null
): void {
  const cx = clamp(Math.round(point.x), 0, Math.max(0, width - 1));
  const cy = clamp(Math.round(point.y), 0, Math.max(0, height - 1));
  const x1 = clamp(cx - radius, 0, Math.max(0, width - 1));
  const y1 = clamp(cy - radius, 0, Math.max(0, height - 1));
  const x2 = clamp(cx + radius, x1, Math.max(0, width - 1));
  const y2 = clamp(cy + radius, y1, Math.max(0, height - 1));
  for (let y = y1; y <= y2; y += 1) {
    for (let x = x1; x <= x2; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > radius * radius) {
        continue;
      }
      if (mode === "paint" && paintColor) {
        writeRgb(bitmap, width, x, y, paintColor);
      } else {
        copyPixel(originalBitmap, bitmap, width, x, y);
      }
    }
  }
}

function sanitizePoints(points: InpaintingPoint[], width: number, height: number): InpaintingPoint[] {
  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: clamp(Math.round(point.x), 0, Math.max(0, width - 1)),
      y: clamp(Math.round(point.y), 0, Math.max(0, height - 1))
    }))
    .slice(0, 1200);
}

function interpolatePoints(from: InpaintingPoint, to: InpaintingPoint, step: number): InpaintingPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const count = Math.max(1, Math.ceil(distance / Math.max(1, step)));
  const points: InpaintingPoint[] = [];
  for (let index = 0; index <= count; index += 1) {
    const ratio = index / count;
    points.push({
      x: from.x + dx * ratio,
      y: from.y + dy * ratio
    });
  }
  return points;
}

function parseHexColor(value?: string): Rgb {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(value ?? "");
  if (!match) {
    return { r: 255, g: 255, b: 255 };
  }
  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16)
  };
}

function rgbToHex(color: Rgb): string {
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function toHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

function writeRgb(bitmap: Buffer, width: number, x: number, y: number, color: Rgb): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = color.b;
  bitmap[offset + 1] = color.g;
  bitmap[offset + 2] = color.r;
  bitmap[offset + 3] = 255;
}

function copyPixel(source: Buffer, target: Buffer, width: number, x: number, y: number): void {
  const offset = (y * width + x) * 4;
  target[offset] = source[offset] ?? 0;
  target[offset + 1] = source[offset + 1] ?? 0;
  target[offset + 2] = source[offset + 2] ?? 0;
  target[offset + 3] = source[offset + 3] ?? 255;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = clamp(Math.round((sortedValues.length - 1) * ratio), 0, sortedValues.length - 1);
  return sortedValues[index] ?? 0;
}

function colorDistance(left: Rgb, right: Rgb): number {
  const dr = left.r - right.r;
  const dg = left.g - right.g;
  const db = left.b - right.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function luminance(color: Rgb): number {
  return color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
}

function resolveInpaintedImagePath(imagePath: string, suffix = "pattern"): string {
  const imageDir = dirname(imagePath);
  const chapterDir = dirname(imageDir);
  const name = basename(imagePath, extname(imagePath));
  const safeSuffix = suffix.replace(/[^a-z0-9_-]/gi, "-");
  return join(chapterDir, "inpainted", `${name}-${safeSuffix}.png`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
