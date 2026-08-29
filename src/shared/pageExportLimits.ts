export const MAX_PAGE_EXPORT_SIDE_PX = 16_384;
export const MAX_PAGE_EXPORT_PIXELS = 16_777_216;
export const MAX_PAGE_EXPORT_ORIGINAL_SIDE_PX = 100_000;
export const MAX_PAGE_EXPORT_ORIGINAL_PIXELS = 120_000_000;
export const MAX_PAGE_EXPORT_PNG_BYTES = 96 * 1024 * 1024;
export const MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES = 512 * 1024 * 1024;
export const MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS =
  Math.ceil(MAX_PAGE_EXPORT_PNG_BYTES / 3) * 4;
export const MAX_PAGE_EXPORT_IMAGE_SOURCE_CHARS =
  MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS + 64;

export type PageExportRasterSize = {
  width: number;
  height: number;
};

export type PageExportResolutionMode = "safe-downscale" | "original";

export type PageExportRasterLimits = {
  maxPixels: number;
  maxSidePx: number;
};

export const SAFE_PAGE_EXPORT_RASTER_LIMITS: PageExportRasterLimits = {
  maxPixels: MAX_PAGE_EXPORT_PIXELS,
  maxSidePx: MAX_PAGE_EXPORT_SIDE_PX,
};

export const ORIGINAL_PAGE_EXPORT_RASTER_LIMITS: PageExportRasterLimits = {
  maxPixels: MAX_PAGE_EXPORT_ORIGINAL_PIXELS,
  maxSidePx: MAX_PAGE_EXPORT_ORIGINAL_SIDE_PX,
};

export const PAGE_EXPORT_SOURCE_RASTER_LIMITS: PageExportRasterLimits = {
  maxPixels: MAX_PAGE_EXPORT_ORIGINAL_PIXELS,
  maxSidePx: MAX_PAGE_EXPORT_ORIGINAL_SIDE_PX,
};

export type PageExportRasterBudgetResult =
  | {
      valid: true;
      pixelCount: number;
    }
  | {
      valid: false;
      reason: "invalid-dimensions" | "side-limit" | "pixel-limit";
    };

export function validatePageExportRasterSize(
  size: PageExportRasterSize,
  limits: PageExportRasterLimits = SAFE_PAGE_EXPORT_RASTER_LIMITS,
): PageExportRasterBudgetResult {
  const { width, height } = size;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    return { valid: false, reason: "invalid-dimensions" };
  }
  if (width > limits.maxSidePx || height > limits.maxSidePx) {
    return { valid: false, reason: "side-limit" };
  }
  if (width > Math.floor(limits.maxPixels / height)) {
    return { valid: false, reason: "pixel-limit" };
  }
  return { valid: true, pixelCount: width * height };
}

export function resolvePageExportRasterLimits(
  mode: PageExportResolutionMode,
): PageExportRasterLimits {
  return mode === "original"
    ? ORIGINAL_PAGE_EXPORT_RASTER_LIMITS
    : SAFE_PAGE_EXPORT_RASTER_LIMITS;
}

export function fitPageExportRasterSize(
  size: PageExportRasterSize,
  limits: PageExportRasterLimits = SAFE_PAGE_EXPORT_RASTER_LIMITS,
): PageExportRasterSize {
  const source = validatePageExportRasterSize(
    size,
    PAGE_EXPORT_SOURCE_RASTER_LIMITS,
  );
  if (!source.valid) {
    throw new Error("Page export source raster exceeds the supported budget.");
  }
  if (validatePageExportRasterSize(size, limits).valid) return { ...size };
  const scale = Math.min(
    limits.maxSidePx / size.width,
    limits.maxSidePx / size.height,
    Math.sqrt(limits.maxPixels / source.pixelCount),
  );
  const fitted = {
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
  };
  while (!validatePageExportRasterSize(fitted, limits).valid) {
    if (fitted.width / size.width >= fitted.height / size.height) {
      fitted.width = Math.max(1, fitted.width - 1);
    } else {
      fitted.height = Math.max(1, fitted.height - 1);
    }
  }
  return fitted;
}

export function pageExportRasterSizesEqual(
  left: PageExportRasterSize,
  right: PageExportRasterSize,
): boolean {
  return left.width === right.width && left.height === right.height;
}

export function estimateBase64DecodedByteLength(value: string): number {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) {
    throw new Error("Invalid base64 length.");
  }
  let padding = 0;
  if (value.endsWith("==")) {
    padding = 2;
  } else if (value.endsWith("=")) {
    padding = 1;
  }
  return (value.length / 4) * 3 - padding;
}
