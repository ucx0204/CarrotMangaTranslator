import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { clamp } from "../../shared/geometry";
import { logWarn } from "../logger";
import { safeCleanup } from "../safeCleanup";
import {
  buildLocalMask,
  compositeFluxOutput,
  cropBitmapFromPage,
  maskBoundsInRect,
  readGeneratedBitmap,
  writePngFromBitmap,
  writePngFromMask,
} from "./imageRaster";
import {
  alignRectToMultiple,
  expandRect,
  rectHasMask,
  resolveFluxProcessSize,
  type PixelRect,
} from "./maskGeometry";
import { FluxWorker, type FluxWorkerLaunchSpec } from "./fluxWorker";

export const FLUX_INPAINT_CONTEXT_PX = 160;
export const FLUX_INPAINT_MASK_PADDING_PX = 16;
export const FLUX_INPAINT_FEATHER_PX = 8;
export const FLUX_INPAINT_MAX_PIXELS = 1024 * 1024;
const FLUX_INPAINT_MULTIPLE = 16;

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
  modelPath?: string;
  vaePath?: string;
  backend: string;
  runRootDir: string;
  isHealthy?: () => boolean;
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
    },
  ) => Promise<void>;
  dispose: () => Promise<void>;
};

export function createFluxEngine(options: {
  launch: FluxWorkerLaunchSpec;
  modelPath?: string;
  vaePath?: string;
  runRootDir: string;
}): FluxInpaintingEngine {
  let worker: FluxWorker | null = null;
  const getWorker = () => {
    if (worker && !worker.isHealthy()) {
      void safeCleanup("dispose unhealthy Flux worker", () =>
        worker?.dispose(),
      );
      worker = null;
    }
    worker ??= new FluxWorker(options.launch);
    return worker;
  };
  return {
    runtimePath: options.launch.runtimePath,
    modelPath: options.modelPath,
    vaePath: options.vaePath,
    backend: options.launch.backend,
    runRootDir: options.runRootDir,
    isHealthy() {
      return !worker || worker.isHealthy();
    },
    async inpaint(bitmap, width, height, mask, windows, runOptions = {}) {
      const featherPx = clamp(
        Math.round(runOptions.featherPx ?? FLUX_INPAINT_FEATHER_PX),
        0,
        48,
      );
      const contextPx = clamp(
        Math.round(runOptions.contextPx ?? FLUX_INPAINT_CONTEXT_PX),
        16,
        256,
      );
      const maskPaddingPx = clamp(
        Math.round(runOptions.maskPaddingPx ?? FLUX_INPAINT_MASK_PADDING_PX),
        0,
        64,
      );
      const maxPixels = clamp(
        Math.round(runOptions.maxPixels ?? FLUX_INPAINT_MAX_PIXELS),
        256 * 256,
        1536 * 1536,
      );
      const runDir = join(
        options.runRootDir,
        `flux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      );
      await mkdir(runDir, { recursive: true });
      let eligibleWindows = 0;
      let processedWindows = 0;
      let unchangedWindows = 0;
      const unchangedStats: Array<{
        crop: number;
        changedRatio: number;
        meanDelta: number;
      }> = [];
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
            FLUX_INPAINT_MULTIPLE,
          );
          const localMask = buildLocalMask(
            mask,
            width,
            paddedBounds,
            maskPaddingPx,
          );
          if (!localMask.some((value) => value > 0)) {
            continue;
          }
          const validationMask =
            maskPaddingPx > 0
              ? buildLocalMask(mask, width, paddedBounds, 0)
              : localMask;
          eligibleWindows += 1;

          const processSize = resolveFluxProcessSize(
            paddedBounds.w,
            paddedBounds.h,
            maxPixels,
            FLUX_INPAINT_MULTIPLE,
          );
          const inputPath = join(runDir, `input-${index}.png`);
          const maskPath = join(runDir, `mask-${index}.png`);
          const outputPath = join(runDir, `output-${index}.png`);
          const cropBitmap = cropBitmapFromPage(bitmap, width, paddedBounds);
          await writePngFromBitmap(
            inputPath,
            cropBitmap,
            paddedBounds.w,
            paddedBounds.h,
            processSize,
          );
          await writePngFromMask(
            maskPath,
            localMask,
            paddedBounds.w,
            paddedBounds.h,
            processSize,
          );

          await getWorker().inpaint(
            {
              input: inputPath,
              mask: maskPath,
              output: outputPath,
              steps: 4,
              strength: 1,
              maxPixels,
              maskPadding: maskPaddingPx,
            },
            runOptions.signal,
          );
          const generated = await readGeneratedBitmap(
            outputPath,
            paddedBounds.w,
            paddedBounds.h,
          );
          const changeStats = measureMaskedRegionChange(
            cropBitmap,
            generated,
            validationMask,
          );
          assertMaskedRegionHasPixels(changeStats, index);
          if (isMaskedRegionEffectivelyUnchanged(changeStats)) {
            unchangedWindows += 1;
            unchangedStats.push({
              crop: index + 1,
              changedRatio: changeStats.changedRatio,
              meanDelta: changeStats.meanDelta,
            });
          }
          compositeFluxOutput(
            bitmap,
            generated,
            mask,
            width,
            paddedBounds,
            featherPx,
          );
          processedWindows += 1;
        }
        if (eligibleWindows > 0 && processedWindows === 0) {
          logWarn("Flux inpainting skipped every eligible crop", {
            eligibleWindows,
          });
        } else if (
          processedWindows > 0 &&
          unchangedWindows === processedWindows
        ) {
          logWarn(
            "Flux inpainting left every masked crop effectively unchanged",
            {
              eligibleWindows,
              processedWindows,
              unchangedStats,
            },
          );
        }
      } finally {
        if (process.env.MGT_KEEP_FLUX_DEBUG !== "1") {
          await safeCleanup("remove Flux inpainting run directory", () =>
            rm(runDir, { recursive: true, force: true }),
          );
        }
      }
    },
    async dispose() {
      await worker?.dispose();
      worker = null;
    },
  };
}

export function resolveDefaultFluxRunRootDir(runtimeDir: string): string {
  const resolvedRuntimeDir = resolve(runtimeDir);
  const inpaintingDir = dirname(resolvedRuntimeDir);
  const modelsDir = dirname(inpaintingDir);
  if (
    basename(inpaintingDir).toLowerCase() === "inpainting" &&
    basename(modelsDir).toLowerCase() === "models"
  ) {
    return join(dirname(modelsDir), "tmp", "runtime", "flux-inpainting");
  }
  return join(resolvedRuntimeDir, "tmp", "flux-inpainting");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function assertMaskedRegionHasPixels(
  stats: MaskedRegionChangeStats,
  index: number,
): void {
  if (stats.maskedPixels <= 0) {
    throw new Error(
      `Flux 원문 지우기 마스크가 비어 있습니다. crop=${index + 1}`,
    );
  }
}

export type MaskedRegionChangeStats = {
  maskedPixels: number;
  changedPixels: number;
  changedRatio: number;
  meanDelta: number;
};

export function isMaskedRegionEffectivelyUnchanged(
  stats: Pick<
    MaskedRegionChangeStats,
    "changedPixels" | "changedRatio" | "meanDelta"
  >,
): boolean {
  return (
    stats.changedPixels <= 0 &&
    stats.changedRatio < 0.0001 &&
    stats.meanDelta < 0.1
  );
}

export function measureMaskedRegionChange(
  before: Buffer,
  after: Buffer,
  mask: Uint8Array,
): MaskedRegionChangeStats {
  let maskedPixels = 0;
  let changedPixels = 0;
  let totalDelta = 0;
  const pixelCount = Math.min(
    mask.length,
    Math.floor(before.length / 4),
    Math.floor(after.length / 4),
  );
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (!mask[pixel]) {
      continue;
    }
    const offset = pixel * 4;
    const delta =
      Math.abs((before[offset] ?? 0) - (after[offset] ?? 0)) +
      Math.abs((before[offset + 1] ?? 0) - (after[offset + 1] ?? 0)) +
      Math.abs((before[offset + 2] ?? 0) - (after[offset + 2] ?? 0));
    maskedPixels += 1;
    totalDelta += delta;
    if (delta >= 8) {
      changedPixels += 1;
    }
  }
  return {
    maskedPixels,
    changedPixels,
    changedRatio: maskedPixels > 0 ? changedPixels / maskedPixels : 0,
    meanDelta: maskedPixels > 0 ? totalDelta / maskedPixels : 0,
  };
}
