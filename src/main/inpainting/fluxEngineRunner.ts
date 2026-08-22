import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { clamp } from "../../shared/geometry";
import { safeCleanup } from "../safeCleanup";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
  FLUX_RUNNER_MASK_PADDING_PX,
} from "./fluxEngineConstants";
import { resolveFluxCropPaths, writeFluxCropInputs } from "./fluxCropIO";
import { cropBitmapFromPage, readGeneratedBitmap } from "./imageRaster";
import {
  buildExclusivePaddedWindowMasks,
  isWindowMaskFullyOwnedByEarlierWindow,
} from "./inpaintingWindowMask";
import { compositeConstrainedFluxOutput } from "./fluxCompositeConstraint";
import { prepareFluxWindow } from "./fluxWindowPreparation";
import {
  isMaskedRegionEffectivelyUnchanged,
  measureMaskedRegionChange,
  type MaskedRegionChangeStats,
} from "./fluxChangeStats";
import { logInpaintingRuntimeWarn } from "./inpaintingRuntimeLogger";
import { reportFluxInpaintSummary } from "./fluxInpaintSummary";
import type { FluxInpaintSummary } from "./fluxInpaintSummary";
import { assertFluxMaskContracts } from "./fluxMaskContracts";
import type { PixelRect } from "./maskGeometry";
import type {
  FluxInpaintDiagnostics,
  FluxInpaintRunnerArgs,
  FluxInpaintRunOptions,
  FluxWindowProcessArgs,
  FluxWindowProcessResult,
  ResolvedFluxInpaintOptions,
} from "./fluxEngineRunnerTypes";

export type { FluxInpaintDiagnostics } from "./fluxEngineRunnerTypes";

const productionDiagnostics: FluxInpaintDiagnostics = {
  warn: logInpaintingRuntimeWarn,
};

export async function runFluxInpaint(
  {
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
  }: FluxInpaintRunnerArgs,
  diagnostics: FluxInpaintDiagnostics = productionDiagnostics,
): Promise<void> {
  assertFluxMaskContracts({
    isolateWindowMasks,
    runOptions,
    windowCount: windows.length,
  });
  const options = resolveFluxInpaintOptions(runOptions);
  const windowMasks =
    (isolateWindowMasks || runOptions.compositeConstraints) &&
    runOptions.windowMasks
      ? buildExclusivePaddedWindowMasks(
          runOptions.windowMasks,
          width,
          height,
          options.maskPaddingPx,
        )
      : undefined;
  const compositeMasks = runOptions.compositeMasks
    ? buildExclusivePaddedWindowMasks(
        runOptions.compositeMasks,
        width,
        height,
        0,
      ).map((masks) => masks.core)
    : undefined;
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
      compositeMasks,
      windowMasks,
      width,
      windows,
    });
    reportFluxInpaintSummary(
      summary,
      diagnostics,
      runOptions.requirePixelChange === true,
    );
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
): Promise<import("./fluxInpaintSummary").FluxInpaintSummary> {
  const summary: FluxInpaintSummary = {
    coveredWindows: 0,
    eligibleWindows: args.windows.length,
    processedWindows: 0,
    unchangedStats: [],
    unchangedWindows: 0,
  };
  for (const [index, window] of args.windows.entries()) {
    throwIfAborted(args.runOptions.signal);
    const result = await processFluxWindow({ ...args, index, window });
    if (!result.eligible) {
      if (result.covered) {
        summary.coveredWindows += 1;
      }
      continue;
    }
    summary.processedWindows += 1;
    if (result.unchanged && result.unchangedStats) {
      summary.unchangedWindows += 1;
      summary.unchangedStats.push(result.unchangedStats);
    }
  }
  return summary;
}

async function processFluxWindow(
  args: FluxWindowProcessArgs,
): Promise<FluxWindowProcessResult> {
  const {
    bitmap,
    compositeMasks,
    getWorker,
    height,
    index,
    tileLargeCrops,
    options,
    runDir,
    runOptions,
    windowMasks,
    width,
  } = args;
  const { crops, effectiveMask } = prepareFluxWindowForProcessing(args);
  if (crops.length === 0) {
    return {
      covered: isWindowMaskFullyOwnedByEarlierWindow(
        runOptions.windowMasks?.[index],
        windowMasks?.[index],
      ),
      eligible: false,
    };
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
    compositeConstrainedFluxOutput({
      bitmap,
      generated,
      effectiveMask,
      width,
      height,
      crop,
      featherPx: resolveCompositeFeatherPx(runOptions, options, index),
      index,
      windowMask: windowMasks?.[index],
      coreWindowMasks: runOptions.windowMasks,
      compositeMasks,
      compositeConstraints: runOptions.compositeConstraints,
    });
  }
  return summarizeFluxWindowChange(changeStats, index);
}

function resolveCompositeFeatherPx(
  runOptions: FluxInpaintRunOptions,
  options: ResolvedFluxInpaintOptions,
  index: number,
): number {
  return clamp(
    Math.round(runOptions.compositeFeatherPx?.[index] ?? options.featherPx),
    0,
    48,
  );
}

function prepareFluxWindowForProcessing({
  height,
  index,
  isolateWindowMasks,
  mask,
  options,
  runOptions,
  tileLargeCrops,
  width,
  window,
  windowMasks,
}: FluxWindowProcessArgs) {
  return prepareFluxWindow({
    cropOptions: options,
    height,
    isolateWindowMasks: isolateWindowMasks || !!runOptions.compositeConstraints,
    mask,
    tileLargeCrops,
    width,
    window,
    windowMask: windowMasks?.[index],
  });
}

function summarizeFluxWindowChange(
  changeStats: MaskedRegionChangeStats[],
  index: number,
): FluxWindowProcessResult {
  const combinedStats = combineFluxChangeStats(changeStats);
  assertMaskedRegionHasPixels(combinedStats, index);
  return summarizeFluxCropChange(combinedStats, index);
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
