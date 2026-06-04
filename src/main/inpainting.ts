import { nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { clamp } from "../shared/geometry";
import type { InpaintingMaskStroke, InpaintingPoint, MangaPage } from "../shared/types";
import {
  ensureMgtFluxKleinRuntime,
  ensureRemoteFile,
  FLUX_MODEL_FILE,
  FLUX_MODEL_REPO,
  FLUX_VAE_FILE,
  FLUX_VAE_REPO,
  hfResolveUrl
} from "./inpainting/fluxAssets";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
  createFluxEngine,
  resolveDefaultFluxRunRootDir,
  type FluxInpaintingEngine,
  type InpaintingRuntimeProgress
} from "./inpainting/fluxEngine";
import {
  bboxToPixelRect,
  expandRect,
  hasUsableBbox,
  mergeFilledRectIntoPage,
  mergeMaskIntoPage,
  mergeRects,
  rectHasMask,
  resolvePatternBlockMarginPx,
  resolvePatternDilationRadius,
  resolvePatternRegionPaddingPx,
  resolvePatternWindowMarginPx,
  type PixelRect
} from "./inpainting/maskGeometry";
import {
  applyRetouchCircle,
  buildMaskFromStrokes,
  buildPatternTextMask,
  interpolatePoints,
  maskComponents,
  parseHexColor,
  readRgb,
  rgbToHex,
  sanitizeMaskStrokes,
  sanitizePoints
} from "./inpainting/rasterMasks";

export type { FluxInpaintingEngine, InpaintingRuntimeProgress };

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
  runRootDir?: string;
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
    vaePath,
    runRootDir: options.runRootDir ?? resolveDefaultFluxRunRootDir(options.runtimeDir)
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
