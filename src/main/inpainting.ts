import { nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { clamp } from "../shared/geometry";
import type { FluxBackend } from "../shared/settingsTypes";
import type { InpaintingRetouchGeometry } from "../shared/inpaintingTypes";
import type { MangaPage } from "../shared/libraryTypes";
import { removeArtifactAfterFailure } from "./artifactCleanup";
import { tMain } from "./i18n";
import {
  FLUX_MODEL_FILE,
  FLUX_MODEL_REPO,
  FLUX_MODEL_REVISION,
  FLUX_MODEL_SHA256,
  FLUX_VAE_FILE,
  FLUX_VAE_REPO,
  FLUX_VAE_REVISION,
  FLUX_VAE_SHA256,
} from "./inpainting/fluxAssets/constants";
import {
  ensureRemoteFile,
  hfResolveUrl,
} from "./runtimeSupport/modelDownloads";
import { createCombinedDownloadProgress } from "./inpainting/fluxAssets/progress";
import { MAX_REMOTE_SUPPORT_ASSET_BYTES } from "./runtimeSupport/downloadBudgets";
import { ensureFluxWorkerLaunch } from "./inpainting/fluxAssets/workerLaunch";
import {
  createFluxEngine,
  resolveDefaultFluxRunRootDir,
  type FluxInpaintingEngine,
} from "./inpainting/fluxEngine";
import { FLUX_INPAINT_MASK_PADDING_PX } from "./inpainting/fluxEngineConstants";
import type { InpaintingRuntimeProgress } from "./inpainting/inpaintingEngine";
export { prepareKoharuInpaintingEngine } from "./inpainting/koharuEngine";
import {
  applyRetouchCircle,
  applyRetouchEllipse,
  applyRetouchRectangle,
  interpolatePoints,
  parseHexColor,
  readRgb,
  rgbToHex,
  sanitizePoints,
} from "./inpainting/rasterMasks";
import { loadPageImage, resolveInpaintedImagePath } from "./inpainting/imageIO";
import type { ImageDecodeFallback } from "./inpainting/inpaintingTypes";
import { normalizeComputeGpuIndex } from "../shared/gpuSettings";
import { persistRetouchDifferenceMask } from "./inpainting/inpaintMaskArtifact";

export type {
  FluxInpaintingEngine,
  ImageDecodeFallback,
  InpaintingRuntimeProgress,
};
export { inpaintPatternPage } from "./inpainting/patternPage";

export async function prepareFluxInpaintingEngine(options: {
  runtimeDir: string;
  modelDir: string;
  fluxBackend?: FluxBackend;
  computeGpuIndex?: number;
  nvidiaComputeCapability?: number | null;
  sm75Fp16Enabled?: boolean;
  runRootDir?: string;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<FluxInpaintingEngine> {
  const launch = await ensureFluxWorkerLaunch({
    runtimeDir: options.runtimeDir,
    modelDir: options.modelDir,
    backend: options.fluxBackend ?? "cuda-native",
    nvidiaComputeCapability: options.nvidiaComputeCapability,
    sm75Fp16Enabled: options.sm75Fp16Enabled,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  launch.computeGpuIndex = normalizeComputeGpuIndex(options.computeGpuIndex);
  let modelPath: string | undefined;
  let vaePath: string | undefined;
  if (usesManagedFluxModelAssets(launch.backend)) {
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
        maximumBytes: MAX_REMOTE_SUPPORT_ASSET_BYTES,
      }),
      ensureRemoteFile({
        ...options,
        onProgress: download.forFile(),
        fileName: FLUX_VAE_FILE,
        label: "Flux small decoder",
        url: hfResolveUrl(FLUX_VAE_REPO, FLUX_VAE_FILE, FLUX_VAE_REVISION),
        expectedSha256: FLUX_VAE_SHA256,
        maximumBytes: MAX_REMOTE_SUPPORT_ASSET_BYTES,
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
  reportFluxEngineReady(options.onProgress, launch.label);

  return createFluxEngine({
    launch,
    modelPath,
    vaePath,
    sm75Fp16Enabled: options.sm75Fp16Enabled === true,
    runRootDir:
      options.runRootDir ?? resolveDefaultFluxRunRootDir(options.runtimeDir),
  });
}

function reportFluxEngineReady(
  onProgress: ((progress: InpaintingRuntimeProgress) => void) | undefined,
  detail: string,
): void {
  onProgress?.({
    progressText: tMain("inpainting.runtime.fluxReady"),
    detail,
    progressMode: "log-only",
    installLogLine: tMain("inpainting.runtime.fluxReadyLog"),
  });
}

function usesManagedFluxModelAssets(backend: string): boolean {
  return ["cuda-native", "zluda-native", "metal-native", "cpu-native"].includes(
    backend,
  );
}

export async function applyInpaintingRetouch(
  page: MangaPage,
  options: {
    mode: "paint" | "restore";
    geometry: InpaintingRetouchGeometry;
    color?: string;
    decodeFallback?: ImageDecodeFallback;
  },
): Promise<MangaPage> {
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
  const changed = applyRetouchGeometry(
    bitmap,
    originalBitmap,
    size.width,
    size.height,
    options,
  );
  if (!changed) return page;

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
  let persistedMask: Awaited<ReturnType<typeof persistRetouchDifferenceMask>>;
  try {
    persistedMask = await persistRetouchDifferenceMask({
      page,
      originalBitmap,
      outputBitmap: bitmap,
      width: size.width,
      height: size.height,
    });
  } catch (error) {
    return removeArtifactAfterFailure(outputPath, error);
  }
  return {
    ...page,
    inpaintedImagePath: outputPath,
    inpaintMaskPath: persistedMask.path,
    maskProvenance: persistedMask.provenance,
    ...(options.mode === "restore" && page.translationCompletion
      ? {
          translationCompletion: {
            workflow: page.translationCompletion.workflow,
            status: "pending" as const,
          },
        }
      : {}),
    updatedAt: new Date().toISOString(),
  };
}

function applyRetouchGeometry(
  bitmap: Buffer,
  originalBitmap: Buffer,
  width: number,
  height: number,
  options: {
    color?: string;
    geometry: InpaintingRetouchGeometry;
    mode: "paint" | "restore";
  },
): boolean {
  const paintColor =
    options.mode === "paint" ? parseHexColor(options.color) : null;
  if (options.geometry.kind === "stroke") {
    const points = sanitizePoints(options.geometry.points, width, height);
    if (points.length === 0) return false;
    applyRetouchStroke(
      bitmap,
      originalBitmap,
      width,
      height,
      points,
      options.geometry.radiusPx,
      options.mode,
      paintColor,
    );
    return true;
  }
  const applyShape =
    options.geometry.kind === "rectangle"
      ? applyRetouchRectangle
      : applyRetouchEllipse;
  applyShape(
    bitmap,
    originalBitmap,
    width,
    height,
    options.geometry,
    options.mode,
    paintColor,
  );
  return true;
}

function applyRetouchStroke(
  bitmap: Buffer,
  originalBitmap: Buffer,
  width: number,
  height: number,
  points: Array<{ x: number; y: number }>,
  radiusPx: number,
  mode: "paint" | "restore",
  paintColor: ReturnType<typeof parseHexColor> | null,
): void {
  const radius = clamp(Math.round(radiusPx), 2, 180);
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
        width,
        height,
        point,
        radius,
        mode,
        paintColor,
      );
    }
  }
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
