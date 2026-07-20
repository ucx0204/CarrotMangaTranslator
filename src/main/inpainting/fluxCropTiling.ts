import {
  FLUX_INPAINT_MULTIPLE,
  FLUX_METAL_TILE_SIZE_PX,
} from "./fluxEngineConstants";
import { buildLocalMask, maskBoundsInRect } from "./imageRaster";
import {
  alignRectToMultiple,
  expandRect,
  rectHasMask,
  resolveContextTiles,
  resolveFluxProcessSize,
  type PixelRect,
} from "./maskGeometry";

export type FluxPreparedCrop = {
  localMask: Uint8Array;
  paddedBounds: PixelRect;
  processSize: { width: number; height: number };
  validationMask: Uint8Array;
  writeBounds: PixelRect;
};

export function prepareFluxWindowCrops(options: {
  contextPx: number;
  featherPx: number;
  height: number;
  inputMask?: Uint8Array;
  inputMaskPaddingPx?: number;
  mask: Uint8Array;
  maskPaddingPx: number;
  maxPixels: number;
  tileLargeCrops: boolean;
  width: number;
  window: PixelRect;
}): FluxPreparedCrop[] {
  if (!rectHasMask(options.mask, options.width, options.window)) {
    return [];
  }
  const maskBounds = maskBoundsInRect(
    options.mask,
    options.width,
    options.window,
  );
  if (!maskBounds) {
    return [];
  }
  const paddedBounds = alignRectToMultiple(
    expandRect(
      maskBounds,
      options.width,
      options.height,
      options.contextPx + options.maskPaddingPx,
    ),
    options.width,
    options.height,
    FLUX_INPAINT_MULTIPLE,
  );
  const tiles = resolveCropTiles(options, maskBounds, paddedBounds);
  return tiles.flatMap(({ cropBounds, writeBounds }) => {
    const localMask = buildLocalMask(
      options.inputMask ?? options.mask,
      options.width,
      cropBounds,
      options.inputMaskPaddingPx ?? options.maskPaddingPx,
    );
    if (!localMask.some((value) => value > 0)) {
      return [];
    }
    return [
      {
        localMask,
        paddedBounds: cropBounds,
        processSize: options.tileLargeCrops
          ? { width: cropBounds.w, height: cropBounds.h }
          : resolveFluxProcessSize(
              cropBounds.w,
              cropBounds.h,
              options.maxPixels,
              FLUX_INPAINT_MULTIPLE,
            ),
        validationMask: buildValidationMask(
          options.mask,
          options.width,
          cropBounds,
          writeBounds,
        ),
        writeBounds,
      },
    ];
  });
}

function resolveCropTiles(
  options: Parameters<typeof prepareFluxWindowCrops>[0],
  maskBounds: PixelRect,
  paddedBounds: PixelRect,
) {
  if (
    !options.tileLargeCrops ||
    (paddedBounds.w <= FLUX_METAL_TILE_SIZE_PX &&
      paddedBounds.h <= FLUX_METAL_TILE_SIZE_PX)
  ) {
    return [{ cropBounds: paddedBounds, writeBounds: paddedBounds }];
  }
  return resolveContextTiles(
    expandRect(maskBounds, options.width, options.height, options.featherPx),
    options.width,
    options.height,
    FLUX_METAL_TILE_SIZE_PX,
    options.contextPx + options.maskPaddingPx,
    FLUX_INPAINT_MULTIPLE,
  );
}

function buildValidationMask(
  mask: Uint8Array,
  pageWidth: number,
  cropBounds: PixelRect,
  writeBounds: PixelRect,
): Uint8Array {
  const validationMask = buildLocalMask(mask, pageWidth, cropBounds, 0);
  const startX = Math.max(0, writeBounds.x - cropBounds.x);
  const startY = Math.max(0, writeBounds.y - cropBounds.y);
  const endX = Math.min(cropBounds.w, startX + writeBounds.w);
  const endY = Math.min(cropBounds.h, startY + writeBounds.h);
  for (let y = 0; y < cropBounds.h; y += 1) {
    for (let x = 0; x < cropBounds.w; x += 1) {
      if (x < startX || x >= endX || y < startY || y >= endY) {
        validationMask[y * cropBounds.w + x] = 0;
      }
    }
  }
  return validationMask;
}
