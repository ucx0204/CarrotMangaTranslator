import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { clamp } from "../../shared/bboxNormalization";
import { safeCleanup } from "../safeCleanup";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_STEPS,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
  FLUX_RUNNER_MASK_PADDING_PX,
} from "./fluxEngineConstants";
import {
  readFluxCropCandidates,
  readFluxWindowCandidates,
  resolveFluxCropPaths,
  matchIllustratedCrop,
  writeFluxCropInputs,
} from "./fluxCropIO";
import { cropBitmapFromPage } from "./imageRaster";
import { isWindowMaskFullyOwnedByEarlierWindow } from "./inpaintingWindowMask";
import { compositeConstrainedFluxOutput } from "./fluxCompositeConstraint";
import {
  areWhitePrintCropsRestored,
  overlappingPrintOrder,
  reconcileOverlappingPrint,
} from "./qwenOverlappingPrint";
import {
  prepareFluxWindow,
  prepareFluxWindowMasks,
} from "./fluxWindowPreparation";
import {
  isMaskedRegionEffectivelyUnchanged,
  measureMaskedRegionChange,
  type MaskedRegionChangeStats,
} from "./fluxChangeStats";
import { logInpaintingRuntimeWarn } from "./inpaintingRuntimeLogger";
import { reportFluxInpaintSummary } from "./fluxInpaintSummary";
import { assertFluxMaskContracts } from "./fluxMaskContracts";
import type { PixelRect } from "./maskGeometry";
import type { FluxPreparedCrop } from "./fluxCropTiling";
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
    modelMaskIsTypography,
    cropStrategy,
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
  const { windowMasks, compositeMasks } = prepareFluxWindowMasks({
    isolateWindowMasks,
    modelMaskIsTypography,
    runOptions,
    width,
    height,
    maskPaddingPx: options.maskPaddingPx,
  });
  const runDir = join(
    runRootDir,
    `flux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(runDir, { recursive: true });
  try {
    const summary = await processFluxWindows({
      bitmap,
      sourceBitmap: Buffer.from(bitmap),
      contextBitmap: Buffer.from(bitmap),
      getWorker,
      height,
      isolateWindowMasks,
      cropStrategy,
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
  const summary: import("./fluxInpaintSummary").FluxInpaintSummary = {
    coveredWindows: 0,
    eligibleWindows: args.windows.length,
    processedWindows: 0,
    unchangedStats: [],
    unchangedWindows: 0,
  };
  for (const index of overlappingPrintOrder(
    args.runOptions,
    args.windows.length,
  )) {
    const window = args.windows[index];
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
    contextBitmap,
    getWorker,
    index,
    cropStrategy,
    options,
    runDir,
    runOptions,
    width,
  } = args;
  const { crops, effectiveMask } = prepareFluxWindowForProcessing(args);
  if (crops.length === 0) {
    return {
      covered: isWindowMaskFullyOwnedByEarlierWindow(
        runOptions.windowMasks?.[index],
        args.windowMasks?.[index],
      ),
      eligible: false,
    };
  }
  if (areWhitePrintCropsRestored(args, crops))
    return { covered: true, eligible: false };
  const changeStats: MaskedRegionChangeStats[] = [];
  for (const [tileIndex, crop] of crops.entries()) {
    throwIfAborted(runOptions.signal);
    const paths = resolveFluxCropPaths(runDir, index, tileIndex);
    const cropBitmap = cropBitmapFromPage(
      contextBitmap,
      width,
      crop.paddedBounds,
    );
    await writeFluxCropInputs(paths, crop, cropBitmap);
    const workerResult = await getWorker().inpaint(
      {
        input: paths.inputPath,
        mask: paths.maskPath,
        output: paths.outputPath,
        steps: runOptions.steps ?? FLUX_INPAINT_STEPS.normal,
        strength: 1,
        maxPixels: ["native", "native-tiled"].includes(cropStrategy)
          ? Math.min(
              options.maxPixels,
              crop.processSize.width * crop.processSize.height,
            )
          : options.maxPixels,
        maskPadding: FLUX_RUNNER_MASK_PADDING_PX,
        speechBubble: runOptions.speechBubbleWindows?.[index],
        ...(runOptions.illustratedTitleWindows?.[index]
          ? { illustratedTitle: runOptions.illustratedTitleWindows[index] }
          : {}),
      },
      runOptions.signal,
    );
    const candidates = await readFluxWindowCandidates(
      paths.outputPath,
      args,
      crop.paddedBounds,
      workerResult === "native-paper",
    );
    const stats = measureMaskedRegionChange(
      cropBitmapFromPage(bitmap, width, crop.paddedBounds),
      candidates.generated,
      crop.validationMask,
    );
    if (stats.maskedPixels > 0) changeStats.push(stats);
    compositeFluxCandidates(args, crop, effectiveMask, candidates);
  }
  return summarizeFluxWindowChange(changeStats, index);
}

function compositeFluxCandidates(
  args: FluxWindowProcessArgs,
  crop: FluxPreparedCrop,
  effectiveMask: Uint8Array,
  candidates: Awaited<ReturnType<typeof readFluxCropCandidates>>,
): void {
  const { index, options, runOptions } = args;
  const common = {
    effectiveMask,
    width: args.width,
    height: args.height,
    crop,
    featherPx: resolveCompositeFeatherPx(runOptions, options, index),
    index,
    windowMask: args.windowMasks?.[index],
    coreWindowMasks: runOptions.windowMasks,
    compositeMasks: args.compositeMasks,
    compositeConstraints: runOptions.compositeConstraints,
  };
  // Keep post-generation paper correction out of subsequent model inputs.
  // The established native/outer-ring composite remains their context.
  compositeConstrainedFluxOutput({
    ...common,
    bitmap: args.contextBitmap,
    generated: candidates.contextGenerated,
  });
  matchIllustratedCrop(args, crop, candidates.generated);
  compositeConstrainedFluxOutput({
    ...common,
    bitmap: args.bitmap,
    generated: candidates.generated,
  });
  reconcileOverlappingPrint(args, crop, candidates.generated);
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
  cropStrategy,
  width,
  window,
  windowMasks,
}: FluxWindowProcessArgs) {
  const hint = runOptions.illustratedTitleWindows?.[index];
  return prepareFluxWindow({
    cropOptions:
      hint === "brush"
        ? { ...options, contextPx: Math.min(options.contextPx, 72) }
        : hint === "balloon-edge-reading"
          ? { ...options, contextPx: Math.max(512, options.contextPx) }
          : options,
    isolatedReference: String(hint).startsWith("jacket:"),
    height,
    isolateWindowMasks: isolateWindowMasks || !!runOptions.compositeConstraints,
    mask,
    cropStrategy,
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
