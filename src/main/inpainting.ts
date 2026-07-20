import { nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { clamp } from "../shared/geometry";
import type { FluxBackend } from "../shared/settingsTypes";
import type {
  InpaintingMaskStroke,
  InpaintingPoint,
} from "../shared/inpaintingTypes";
import type { MangaPage } from "../shared/libraryTypes";
import { tMain } from "./i18n";
import {
  createCombinedDownloadProgress,
  ensureFluxWorkerLaunch,
  ensureRemoteFile,
  FLUX_MODEL_FILE,
  FLUX_MODEL_REPO,
  FLUX_MODEL_REVISION,
  FLUX_MODEL_SHA256,
  FLUX_VAE_FILE,
  FLUX_VAE_REPO,
  FLUX_VAE_REVISION,
  FLUX_VAE_SHA256,
  hfResolveUrl,
} from "./inpainting/fluxAssets";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
  createFluxEngine,
  resolveDefaultFluxRunRootDir,
  type FluxInpaintingEngine,
  type InpaintingRuntimeProgress,
} from "./inpainting/fluxEngine";
import type { InpaintingEngine } from "./inpainting/inpaintingEngine";
export { prepareKoharuInpaintingEngine } from "./inpainting/koharuEngine";
import { expandRect, rectHasMask } from "./inpainting/maskGeometry";
import { resolvePatternInpaintWindows } from "./inpainting/patternWindowPolicy";
import {
  applyRetouchCircle,
  buildMaskFromStrokes,
  interpolatePoints,
  maskComponents,
  parseHexColor,
  readRgb,
  rgbToHex,
  sanitizeMaskStrokes,
  sanitizePoints,
} from "./inpainting/rasterMasks";
import { loadPageImage, resolveInpaintedImagePath } from "./inpainting/imageIO";
import type {
  ImageDecodeFallback,
  PatternPageInpaintingResult,
} from "./inpainting/inpaintingTypes";

export type {
  FluxInpaintingEngine,
  ImageDecodeFallback,
  InpaintingEngine,
  InpaintingRuntimeProgress,
  PatternPageInpaintingResult,
};
export { inpaintPatternPage } from "./inpainting/patternPage";

export async function inpaintDrawnPatternPage(
  page: MangaPage,
  options: {
    strokes: InpaintingMaskStroke[];
    signal?: AbortSignal;
    decodeFallback?: ImageDecodeFallback;
    inpaintingEngine?: InpaintingEngine;
    featherPx?: number;
  },
): Promise<PatternPageInpaintingResult> {
  const strokes = sanitizeMaskStrokes(options.strokes, page.width, page.height);
  if (strokes.length === 0) {
    return { page, blocksErased: 0 };
  }

  const image = await loadPageImage(
    page.inpaintedImagePath ?? page.imagePath,
    options.decodeFallback,
  );
  const size = image.getSize();
  if (!size.width || !size.height) {
    throw new Error(tMain("inpainting.errors.pageRead", { page: page.name }));
  }

  const bitmap = Buffer.from(image.toBitmap());
  if (bitmap.length < size.width * size.height * 4) {
    throw new Error(
      tMain("inpainting.errors.bitmapCreate", { page: page.name }),
    );
  }

  const pageMask = buildMaskFromStrokes(strokes, size.width, size.height);
  const components = maskComponents(pageMask, size.width, size.height, 12)
    .map((component) => ({
      ...component,
      window: expandRect(
        component.rect,
        size.width,
        size.height,
        FLUX_INPAINT_CONTEXT_PX,
      ),
    }))
    .filter((component) => rectHasMask(pageMask, size.width, component.window));
  if (components.length === 0) {
    return { page, blocksErased: 0 };
  }

  if (!options.inpaintingEngine) {
    throw new Error(tMain("inpainting.errors.engineNotReady"));
  }

  await options.inpaintingEngine.inpaint(
    bitmap,
    size.width,
    size.height,
    pageMask,
    resolvePatternInpaintWindows(
      components.map((component) => component.window),
      options.inpaintingEngine,
    ),
    {
      signal: options.signal,
      featherPx: options.featherPx ?? FLUX_INPAINT_FEATHER_PX,
      contextPx: FLUX_INPAINT_CONTEXT_PX,
      maskPaddingPx: FLUX_INPAINT_MASK_PADDING_PX,
      maxPixels: FLUX_INPAINT_MAX_PIXELS,
      bubbleMask:
        options.inpaintingEngine.model === "flux-klein"
          ? undefined
          : new Uint8Array(size.width * size.height),
      windowMasks:
        options.inpaintingEngine.model === "flux-klein" &&
        options.inpaintingEngine.backend === "metal-native"
          ? components.map((component) => ({
              bounds: component.rect,
              data: component.data,
            }))
          : undefined,
    },
  );

  return writeDrawnInpaintingResult(page, bitmap, size, components.length);
}

async function writeDrawnInpaintingResult(
  page: MangaPage,
  bitmap: Buffer,
  size: { width: number; height: number },
  blocksErased: number,
): Promise<PatternPageInpaintingResult> {
  const outputImage = nativeImage.createFromBitmap(bitmap, {
    width: size.width,
    height: size.height,
  });
  if (outputImage.isEmpty()) {
    throw new Error(
      tMain("inpainting.errors.resultCreate", { page: page.name }),
    );
  }

  const outputPath = resolveInpaintedImagePath(page.imagePath, "pattern-drawn");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputImage.toPNG());

  return {
    blocksErased,
    page: {
      ...page,
      inpaintedImagePath: outputPath,
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function prepareFluxInpaintingEngine(options: {
  runtimeDir: string;
  modelDir: string;
  fluxBackend?: FluxBackend;
  nvidiaComputeCapability?: number | null;
  runRootDir?: string;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<FluxInpaintingEngine> {
  const launch = await ensureFluxWorkerLaunch({
    runtimeDir: options.runtimeDir,
    modelDir: options.modelDir,
    backend: options.fluxBackend ?? "cuda-native",
    nvidiaComputeCapability: options.nvidiaComputeCapability,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  let modelPath: string | undefined;
  let vaePath: string | undefined;
  if (
    launch.backend === "cuda-native" ||
    launch.backend === "zluda-native" ||
    launch.backend === "metal-native"
  ) {
    const download = createCombinedDownloadProgress(
      options.onProgress,
      tMain("inpainting.assets.fluxModel"),
    );
    [modelPath, vaePath] = await Promise.all([
      ensureRemoteFile({
        ...options,
        onProgress: download.forFile(),
        fileName: FLUX_MODEL_FILE,
        label: "Flux Klein 4B",
        url: hfResolveUrl(
          FLUX_MODEL_REPO,
          FLUX_MODEL_FILE,
          FLUX_MODEL_REVISION,
        ),
        expectedSha256: FLUX_MODEL_SHA256,
      }),
      ensureRemoteFile({
        ...options,
        onProgress: download.forFile(),
        fileName: FLUX_VAE_FILE,
        label: "Flux small decoder",
        url: hfResolveUrl(FLUX_VAE_REPO, FLUX_VAE_FILE, FLUX_VAE_REVISION),
        expectedSha256: FLUX_VAE_SHA256,
      }),
    ]);
    launch.args = [
      ...launch.args,
      "--transformer-path",
      modelPath,
      "--vae-path",
      vaePath,
      "--steps",
      "4",
      "--strength",
      "1",
      "--mask-padding",
      String(FLUX_INPAINT_MASK_PADDING_PX),
    ];
  }

  options.onProgress?.({
    progressText: tMain("inpainting.runtime.fluxReady"),
    detail: launch.label,
    progressMode: "log-only",
    installLogLine: tMain("inpainting.runtime.fluxReadyLog"),
  });

  return createFluxEngine({
    launch,
    modelPath,
    vaePath,
    runRootDir:
      options.runRootDir ?? resolveDefaultFluxRunRootDir(options.runtimeDir),
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
  },
): Promise<MangaPage> {
  const points = sanitizePoints(options.points, page.width, page.height);
  if (points.length === 0) {
    return page;
  }

  const baseImage = await loadPageImage(
    page.inpaintedImagePath ?? page.imagePath,
    options.decodeFallback,
  );
  const originalImage = await loadPageImage(
    page.imagePath,
    options.decodeFallback,
  );
  const size = baseImage.getSize();
  const originalSize = originalImage.getSize();
  if (
    size.width !== originalSize.width ||
    size.height !== originalSize.height
  ) {
    throw new Error(tMain("inpainting.errors.imageSizeMismatch"));
  }

  const bitmap = Buffer.from(baseImage.toBitmap());
  const originalBitmap = Buffer.from(originalImage.toBitmap());
  const radius = clamp(Math.round(options.radiusPx), 2, 180);
  const paintColor =
    options.mode === "paint" ? parseHexColor(options.color) : null;

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    for (const point of interpolatePoints(
      previous,
      current,
      Math.max(1, radius * 0.35),
    )) {
      applyRetouchCircle(
        bitmap,
        originalBitmap,
        size.width,
        size.height,
        point,
        radius,
        options.mode,
        paintColor,
      );
    }
  }

  const outputImage = nativeImage.createFromBitmap(bitmap, {
    width: size.width,
    height: size.height,
  });
  if (outputImage.isEmpty()) {
    throw new Error(
      tMain("inpainting.errors.retouchCreate", { page: page.name }),
    );
  }

  const outputPath = resolveInpaintedImagePath(page.imagePath, "retouch");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputImage.toPNG());
  return {
    ...page,
    inpaintedImagePath: outputPath,
    updatedAt: new Date().toISOString(),
  };
}

export async function sampleImageColor(
  imagePath: string,
  x: number,
  y: number,
  decodeFallback?: ImageDecodeFallback,
): Promise<string> {
  const image = await loadPageImage(imagePath, decodeFallback);
  const size = image.getSize();
  const bitmap = Buffer.from(image.toBitmap());
  const px = clamp(Math.round(x), 0, Math.max(0, size.width - 1));
  const py = clamp(Math.round(y), 0, Math.max(0, size.height - 1));
  return rgbToHex(readRgb(bitmap, size.width, px, py));
}
