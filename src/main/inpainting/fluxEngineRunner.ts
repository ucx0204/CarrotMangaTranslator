import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { safeCleanup } from "../safeCleanup";
import { throwIfAborted } from "./fluxAssets/errors";
import {
  FLUX_INPAINT_STEPS,
  FLUX_RUNNER_MASK_PADDING_PX,
} from "./fluxEngineConstants";
import {
  readFluxWindowCandidates,
  resolveFluxCropPaths,
  matchIllustratedCrop,
  writeFluxCropInputs,
} from "./fluxCropIO";
import { cropBitmapFromPage, readGeneratedBitmap } from "./imageRaster";
import { isWindowMaskFullyOwnedByEarlierWindow } from "./inpaintingWindowMask";
import { prepareFluxComposite } from "./fluxCompositeConstraint";
import {
  areWhitePrintCropsRestored,
  overlappingPrintOrder,
  reconcileOverlappingPrint,
} from "./qwenOverlappingPrint";
import {
  prepareFluxWindowGroups,
  resolveFluxInpaintOptions,
  prepareFluxWindowMasks,
  type PreparedFluxWindow,
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
import type { FluxCropInput } from "./fluxCropTiling";
import type {
  FluxInpaintDiagnostics,
  FluxInpaintRunnerArgs,
  FluxWindowProcessArgs,
  FluxWindowProcessResult,
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
    packLightWindows = false,
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
    const summary = await processFluxWindows(
      {
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
      },
      packLightWindows,
    );
    reportFluxInpaintSummary(
      summary,
      diagnostics,
      runOptions.requirePixelChange === true,
    );
  } finally {
    await cleanupFluxRunDir(runDir);
  }
}

async function processFluxWindows(
  args: Omit<FluxWindowProcessArgs, "index" | "window"> & {
    windows: PixelRect[];
  },
  packLightWindows: boolean,
): Promise<import("./fluxInpaintSummary").FluxInpaintSummary> {
  const summary: import("./fluxInpaintSummary").FluxInpaintSummary = {
    coveredWindows: 0,
    eligibleWindows: args.windows.length,
    processedWindows: 0,
    unchangedStats: [],
    unchangedWindows: 0,
  };
  const order = overlappingPrintOrder(args.runOptions, args.windows.length);
  for (const { members, input } of prepareFluxWindowGroups(
    args,
    order,
    packLightWindows,
  )) {
    const shared = input
      ? await generateSharedCrop(members[0].args, input)
      : undefined;
    for (const member of members) {
      throwIfAborted(args.runOptions.signal);
      recordWindowResult(summary, await processFluxWindow(member, shared));
    }
  }
  return summary;
}

function recordWindowResult(
  summary: import("./fluxInpaintSummary").FluxInpaintSummary,
  result: FluxWindowProcessResult,
) {
  if (!result.eligible) {
    if (result.covered) summary.coveredWindows++;
    return;
  }
  summary.processedWindows++;
  if (result.unchanged && result.unchangedStats) {
    summary.unchangedWindows++;
    summary.unchangedStats.push(result.unchangedStats);
  }
}

async function generateFluxCrop(
  args: FluxWindowProcessArgs,
  crop: FluxCropInput,
  tileIndex: number,
) {
  const {
    contextBitmap,
    getWorker,
    index,
    cropStrategy,
    options,
    runDir,
    runOptions,
    width,
  } = args;
  throwIfAborted(runOptions.signal);
  const paths = resolveFluxCropPaths(runDir, index, tileIndex);
  const cropBitmap = cropBitmapFromPage(
    contextBitmap,
    width,
    crop.paddedBounds,
  );
  await writeFluxCropInputs(paths, crop, cropBitmap);
  const result = await getWorker().inpaint(
    {
      input: paths.inputPath,
      mask: paths.maskPath,
      output: paths.outputPath,
      steps: runOptions.steps ?? FLUX_INPAINT_STEPS.normal,
      strength: 1,
      maxPixels: ["native", "native-tiled"].includes(cropStrategy)
        ? Math.min(
            options.maxPixels,
            crop.workerMaxPixels ??
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
  return { output: paths.outputPath, nativePaper: result === "native-paper" };
}

async function generateSharedCrop(
  args: FluxWindowProcessArgs,
  crop: FluxCropInput,
) {
  const { output, nativePaper } = await generateFluxCrop(args, crop, 0);
  const bounds = crop.paddedBounds;
  return {
    bitmap: await readGeneratedBitmap(
      output,
      bounds.w,
      bounds.h,
      crop.processSize,
    ),
    bounds,
    nativePaper,
  };
}

async function processFluxWindow(
  { args, crops, effectiveMask, featherPx }: PreparedFluxWindow,
  shared?: Awaited<ReturnType<typeof generateSharedCrop>>,
): Promise<FluxWindowProcessResult> {
  const { bitmap, index, runOptions, width } = args;
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
  const composite = prepareFluxComposite({
    useGeneratedAlpha: args.cropStrategy !== "worker-resize",
    effectiveMask,
    width: args.width,
    height: args.height,
    featherPx,
    index,
    windowMask: args.windowMasks?.[index],
    coreWindowMasks: runOptions.windowMasks,
    compositeMasks: args.compositeMasks,
    compositeConstraints: runOptions.compositeConstraints,
  });
  const changeStats: MaskedRegionChangeStats[] = [];
  for (const [tileIndex, crop] of crops.entries()) {
    throwIfAborted(runOptions.signal);
    const { output, nativePaper } = shared
      ? {
          output: cropBitmapFromPage(shared.bitmap, shared.bounds.w, {
            ...crop.paddedBounds,
            x: crop.paddedBounds.x - shared.bounds.x,
            y: crop.paddedBounds.y - shared.bounds.y,
          }),
          nativePaper: shared.nativePaper,
        }
      : await generateFluxCrop(args, crop, tileIndex);
    const candidates = await readFluxWindowCandidates(
      output,
      args,
      crop,
      nativePaper,
    );
    const stats = measureMaskedRegionChange(
      cropBitmapFromPage(bitmap, width, crop.paddedBounds),
      candidates.generated,
      crop.validationMask,
      args.cropStrategy !== "worker-resize",
    );
    if (stats.maskedPixels > 0) changeStats.push(stats);
    throwIfAborted(runOptions.signal);
    // Later crops use the inference context before final paper corrections.
    composite(args.contextBitmap, candidates.contextGenerated, crop);
    matchIllustratedCrop(args, crop, candidates.generated);
    composite(bitmap, candidates.generated, crop);
    reconcileOverlappingPrint(args, crop, candidates.generated);
  }
  return summarizeFluxWindowChange(changeStats, index);
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
