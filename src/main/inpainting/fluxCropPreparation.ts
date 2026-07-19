import { join } from "node:path";
import {
  FLUX_INPAINT_MULTIPLE,
  FLUX_METAL_TILE_SIZE_PX,
} from "./fluxEngineConstants";
import {
  buildLocalMask,
  maskBoundsInRect,
  writePngFromBitmap,
  writePngFromMask,
} from "./imageRaster";
import {
  alignRectToMultiple,
  expandRect,
  rectHasMask,
  resolveContextTiles,
  resolveFluxProcessSize,
  type PixelRect,
} from "./maskGeometry";

type FluxCropOptions = {
  contextPx: number;
  maskPaddingPx: number;
  maxPixels: number;
};

export type FluxPreparedCrop = {
  localMask: Uint8Array;
  paddedBounds: PixelRect;
  processSize: { width: number; height: number };
  validationMask: Uint8Array;
  writeBounds: PixelRect;
};

export function prepareFluxWindowCrops(
  mask: Uint8Array,
  width: number,
  height: number,
  window: PixelRect,
  options: FluxCropOptions,
  tileLargeCrops: boolean,
): FluxPreparedCrop[] {
  if (!rectHasMask(mask, width, window)) {
    return [];
  }
  const maskBounds = maskBoundsInRect(mask, width, window);
  if (!maskBounds) {
    return [];
  }
  const paddedBounds = alignRectToMultiple(
    expandRect(
      maskBounds,
      width,
      height,
      options.contextPx + options.maskPaddingPx,
    ),
    width,
    height,
    FLUX_INPAINT_MULTIPLE,
  );
  const tiles = tileLargeCrops
    ? resolveContextTiles(
        paddedBounds,
        width,
        height,
        FLUX_METAL_TILE_SIZE_PX,
        options.contextPx,
        FLUX_INPAINT_MULTIPLE,
      )
    : [{ cropBounds: paddedBounds, writeBounds: paddedBounds }];
  return tiles.flatMap(({ cropBounds, writeBounds }) => {
    const localMask = buildLocalMask(
      mask,
      width,
      cropBounds,
      options.maskPaddingPx,
    );
    const validationMask = buildValidationMask(
      mask,
      width,
      cropBounds,
      writeBounds,
    );
    if (!validationMask.some((value) => value > 0)) {
      return [];
    }
    return [
      {
        localMask,
        paddedBounds: cropBounds,
        processSize: tileLargeCrops
          ? { width: cropBounds.w, height: cropBounds.h }
          : resolveFluxProcessSize(
              cropBounds.w,
              cropBounds.h,
              options.maxPixels,
              FLUX_INPAINT_MULTIPLE,
            ),
        validationMask,
        writeBounds,
      },
    ];
  });
}

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

function buildValidationMask(
  mask: Uint8Array,
  pageWidth: number,
  cropBounds: PixelRect,
  writeBounds: PixelRect,
): Uint8Array {
  const validationMask = buildLocalMask(mask, pageWidth, cropBounds, 0);
  for (let y = 0; y < cropBounds.h; y += 1) {
    const pageY = cropBounds.y + y;
    for (let x = 0; x < cropBounds.w; x += 1) {
      const pageX = cropBounds.x + x;
      if (!rectContainsPoint(writeBounds, pageX, pageY)) {
        validationMask[y * cropBounds.w + x] = 0;
      }
    }
  }
  return validationMask;
}

function rectContainsPoint(rect: PixelRect, x: number, y: number): boolean {
  return (
    x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
  );
}
