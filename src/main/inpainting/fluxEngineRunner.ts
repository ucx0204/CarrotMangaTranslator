import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { clamp } from "../../shared/geometry";
import { logWarn } from "../logger";
import { safeCleanup } from "../safeCleanup";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
  FLUX_RUNNER_MASK_PADDING_PX,
} from "./fluxEngineConstants";
import { prepareFluxWindowCrops } from "./fluxCropTiling";
import { FluxWorker } from "./fluxWorker";
import {
  compositeFluxOutput,
  cropBitmapFromPage,
  isolateMaskToWindow,
  readGeneratedBitmap,
  writePngFromBitmap,
  writePngFromMask,
} from "./imageRaster";
import type { PixelRect } from "./maskGeometry";
import {
  isMaskedRegionEffectivelyUnchanged,
  measureMaskedRegionChange,
  type MaskedRegionChangeStats,
} from "./fluxChangeStats";

type FluxInpaintRunOptions = {
  signal?: AbortSignal;
  featherPx?: number;
  contextPx?: number;
  maskPaddingPx?: number;
  maxPixels?: number;
};

type ResolvedFluxInpaintOptions = {
  contextPx: number;
  featherPx: number;
  maskPaddingPx: number;
  maxPixels: number;
};

type FluxInpaintRunnerArgs = {
  bitmap: Buffer;
  getWorker: () => FluxWorker;
  height: number;
  isolateWindowMasks: boolean;
  tileLargeCrops: boolean;
  mask: Uint8Array;
  runOptions: FluxInpaintRunOptions;
  runRootDir: string;
  width: number;
  windows: PixelRect[];
};

type FluxWindowProcessArgs = {
  bitmap: Buffer;
  getWorker: () => FluxWorker;
  height: number;
  index: number;
  isolateWindowMasks: boolean;
  tileLargeCrops: boolean;
  mask: Uint8Array;
  options: ResolvedFluxInpaintOptions;
  runDir: string;
  runOptions: FluxInpaintRunOptions;
  width: number;
  window: PixelRect;
};

type FluxWindowProcessResult =
  | {
      eligible: false;
    }
  | {
      eligible: true;
      unchanged: boolean;
      unchangedStats?: FluxUnchangedCropStats;
    };

type FluxInpaintSummary = {
  eligibleWindows: number;
  processedWindows: number;
  unchangedStats: FluxUnchangedCropStats[];
  unchangedWindows: number;
};

type FluxUnchangedCropStats = {
  changedRatio: number;
  crop: number;
  meanDelta: number;
};

export async function runFluxInpaint({
  bitmap,
  getWorker,
  height,
  isolateWindowMasks,
  tileLargeCrops,
  mask,
  runOptions,
  runRootDir,
  width,
  windows,
}: FluxInpaintRunnerArgs): Promise<void> {
  const options = resolveFluxInpaintOptions(runOptions);
  const runDir = join(
    runRootDir,
    `flux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(runDir, { recursive: true });
  try {
    const summary = await processFluxWindows({
      bitmap,
      getWorker,
      height,
      isolateWindowMasks,
      tileLargeCrops,
      mask,
      options,
      runDir,
      runOptions,
      width,
      windows,
    });
    logFluxInpaintSummary(summary);
  } finally {
    await cleanupFluxRunDir(runDir);
  }
}

function resolveFluxInpaintOptions(
  runOptions: FluxInpaintRunOptions,
): ResolvedFluxInpaintOptions {
  return {
    featherPx: clamp(
      Math.round(runOptions.featherPx ?? FLUX_INPAINT_FEATHER_PX),
      0,
      48,
    ),
    contextPx: clamp(
      Math.round(runOptions.contextPx ?? FLUX_INPAINT_CONTEXT_PX),
      16,
      256,
    ),
    maskPaddingPx: clamp(
      Math.round(runOptions.maskPaddingPx ?? FLUX_INPAINT_MASK_PADDING_PX),
      0,
      64,
    ),
    maxPixels: clamp(
      Math.round(runOptions.maxPixels ?? FLUX_INPAINT_MAX_PIXELS),
      256 * 256,
      1536 * 1536,
    ),
  };
}

async function processFluxWindows(
  args: Omit<FluxWindowProcessArgs, "index" | "window"> & {
    windows: PixelRect[];
  },
): Promise<FluxInpaintSummary> {
  const summary: FluxInpaintSummary = {
    eligibleWindows: 0,
    processedWindows: 0,
    unchangedStats: [],
    unchangedWindows: 0,
  };
  for (const [index, window] of args.windows.entries()) {
    throwIfAborted(args.runOptions.signal);
    const result = await processFluxWindow({ ...args, index, window });
    if (!result.eligible) {
      continue;
    }
    summary.eligibleWindows += 1;
    summary.processedWindows += 1;
    if (result.unchanged && result.unchangedStats) {
      summary.unchangedWindows += 1;
      summary.unchangedStats.push(result.unchangedStats);
    }
  }
  return summary;
}

async function processFluxWindow({
  bitmap,
  getWorker,
  height,
  index,
  isolateWindowMasks,
  tileLargeCrops,
  mask,
  options,
  runDir,
  runOptions,
  width,
  window,
}: FluxWindowProcessArgs): Promise<FluxWindowProcessResult> {
  const effectiveMask = isolateWindowMasks
    ? isolateMaskToWindow(mask, width, window)
    : mask;
  const crops = prepareFluxWindowCrops({
    ...options,
    height,
    mask: effectiveMask,
    tileLargeCrops,
    width,
    window,
  });
  if (crops.length === 0) {
    return { eligible: false };
  }
  const changeStats: MaskedRegionChangeStats[] = [];
  for (const [tileIndex, crop] of crops.entries()) {
    throwIfAborted(runOptions.signal);
    const paths = resolveFluxCropPaths(runDir, index, tileIndex);
    const cropBitmap = cropBitmapFromPage(bitmap, width, crop.paddedBounds);
    await writeFluxCropInputs(paths, crop, cropBitmap);
    await getWorker().inpaint(
      {
        input: paths.inputPath,
        mask: paths.maskPath,
        output: paths.outputPath,
        steps: 4,
        strength: 1,
        maxPixels: tileLargeCrops
          ? Math.min(
              options.maxPixels,
              crop.processSize.width * crop.processSize.height,
            )
          : options.maxPixels,
        maskPadding: FLUX_RUNNER_MASK_PADDING_PX,
      },
      runOptions.signal,
    );
    const generated = await readGeneratedBitmap(
      paths.outputPath,
      crop.paddedBounds.w,
      crop.paddedBounds.h,
    );
    const stats = measureMaskedRegionChange(
      cropBitmap,
      generated,
      crop.validationMask,
    );
    if (stats.maskedPixels > 0) {
      changeStats.push(stats);
    }
    compositeFluxOutput(
      bitmap,
      generated,
      effectiveMask,
      width,
      crop.paddedBounds,
      options.featherPx,
      crop.writeBounds,
    );
  }
  const combinedStats = combineFluxChangeStats(changeStats);
  assertMaskedRegionHasPixels(combinedStats, index);
  return summarizeFluxCropChange(combinedStats, index);
}

function resolveFluxCropPaths(
  runDir: string,
  index: number,
  tileIndex: number,
): { inputPath: string; maskPath: string; outputPath: string } {
  const stem = `${index}-${tileIndex}`;
  return {
    inputPath: join(runDir, `input-${stem}.png`),
    maskPath: join(runDir, `mask-${stem}.png`),
    outputPath: join(runDir, `output-${stem}.png`),
  };
}

async function writeFluxCropInputs(
  paths: { inputPath: string; maskPath: string },
  crop: {
    localMask: Uint8Array;
    paddedBounds: PixelRect;
    processSize: { width: number; height: number };
  },
  cropBitmap: Buffer,
): Promise<void> {
  await writePngFromBitmap(
    paths.inputPath,
    cropBitmap,
    crop.paddedBounds.w,
    crop.paddedBounds.h,
    crop.processSize,
  );
  await writePngFromMask(
    paths.maskPath,
    crop.localMask,
    crop.paddedBounds.w,
    crop.paddedBounds.h,
    crop.processSize,
  );
}

function combineFluxChangeStats(
  stats: MaskedRegionChangeStats[],
): MaskedRegionChangeStats {
  const maskedPixels = stats.reduce(
    (total, current) => total + current.maskedPixels,
    0,
  );
  const changedPixels = stats.reduce(
    (total, current) => total + current.changedPixels,
    0,
  );
  const totalDelta = stats.reduce(
    (total, current) => total + current.meanDelta * current.maskedPixels,
    0,
  );
  return {
    maskedPixels,
    changedPixels,
    changedRatio: maskedPixels > 0 ? changedPixels / maskedPixels : 0,
    meanDelta: maskedPixels > 0 ? totalDelta / maskedPixels : 0,
  };
}

function summarizeFluxCropChange(
  changeStats: MaskedRegionChangeStats,
  index: number,
): FluxWindowProcessResult {
  if (!isMaskedRegionEffectivelyUnchanged(changeStats)) {
    return { eligible: true, unchanged: false };
  }
  return {
    eligible: true,
    unchanged: true,
    unchangedStats: {
      crop: index + 1,
      changedRatio: changeStats.changedRatio,
      meanDelta: changeStats.meanDelta,
    },
  };
}

function logFluxInpaintSummary({
  eligibleWindows,
  processedWindows,
  unchangedStats,
  unchangedWindows,
}: FluxInpaintSummary): void {
  if (eligibleWindows > 0 && processedWindows === 0) {
    logWarn("Flux inpainting skipped every eligible crop", {
      eligibleWindows,
    });
    return;
  }
  if (processedWindows > 0 && unchangedWindows === processedWindows) {
    logWarn("Flux inpainting left every masked crop effectively unchanged", {
      eligibleWindows,
      processedWindows,
      unchangedStats,
    });
  }
}

async function cleanupFluxRunDir(runDir: string): Promise<void> {
  if (process.env.MGT_KEEP_FLUX_DEBUG === "1") {
    return;
  }
  await safeCleanup("remove Flux inpainting run directory", () =>
    rm(runDir, { recursive: true, force: true }),
  );
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
