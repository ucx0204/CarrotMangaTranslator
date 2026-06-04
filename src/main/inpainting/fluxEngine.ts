import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { clamp } from "../../shared/geometry";
import {
  buildLocalMask,
  compositeFluxOutput,
  cropBitmapFromPage,
  maskBoundsInRect,
  readGeneratedBitmap,
  writePngFromBitmap,
  writePngFromMask
} from "./imageRaster";
import {
  alignRectToMultiple,
  expandRect,
  rectHasMask,
  resolveFluxProcessSize,
  type PixelRect
} from "./maskGeometry";
import { FluxWorker } from "./fluxWorker";

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
  modelPath: string;
  vaePath: string;
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
    }
  ) => Promise<void>;
  dispose: () => Promise<void>;
};

export function createFluxEngine(options: {
  runtimePath: string;
  modelPath: string;
  vaePath: string;
  runRootDir: string;
}): FluxInpaintingEngine {
  let worker: FluxWorker | null = null;
  const getWorker = () => {
    if (worker && !worker.isHealthy()) {
      void worker.dispose().catch(() => {});
      worker = null;
    }
    worker ??= new FluxWorker(options.runtimePath, options.modelPath, options.vaePath, FLUX_INPAINT_MASK_PADDING_PX);
    return worker;
  };
  return {
    runtimePath: options.runtimePath,
    modelPath: options.modelPath,
    vaePath: options.vaePath,
    runRootDir: options.runRootDir,
    isHealthy() {
      return !worker || worker.isHealthy();
    },
    async inpaint(bitmap, width, height, mask, windows, runOptions = {}) {
      const featherPx = clamp(Math.round(runOptions.featherPx ?? FLUX_INPAINT_FEATHER_PX), 0, 48);
      const contextPx = clamp(Math.round(runOptions.contextPx ?? FLUX_INPAINT_CONTEXT_PX), 16, 256);
      const maskPaddingPx = clamp(Math.round(runOptions.maskPaddingPx ?? FLUX_INPAINT_MASK_PADDING_PX), 0, 64);
      const maxPixels = clamp(Math.round(runOptions.maxPixels ?? FLUX_INPAINT_MAX_PIXELS), 256 * 256, 1536 * 1536);
      const runDir = join(options.runRootDir, `flux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
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

export function resolveDefaultFluxRunRootDir(runtimeDir: string): string {
  const resolvedRuntimeDir = resolve(runtimeDir);
  const inpaintingDir = dirname(resolvedRuntimeDir);
  const modelsDir = dirname(inpaintingDir);
  if (basename(inpaintingDir).toLowerCase() === "inpainting" && basename(modelsDir).toLowerCase() === "models") {
    return join(dirname(modelsDir), "tmp", "runtime", "flux-inpainting");
  }
  return join(resolvedRuntimeDir, "tmp", "flux-inpainting");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
