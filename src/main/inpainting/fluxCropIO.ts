import { join } from "node:path";
import type { FluxPreparedCrop } from "./fluxCropTiling";
import { writePngFromBitmap, writePngFromMask } from "./imageRaster";

export function resolveFluxCropPaths(
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

export async function writeFluxCropInputs(
  paths: { inputPath: string; maskPath: string },
  crop: FluxPreparedCrop,
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
