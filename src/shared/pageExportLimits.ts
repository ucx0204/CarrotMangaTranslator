export const MAX_PAGE_EXPORT_SIDE_PX = 16_384;
export const MAX_PAGE_EXPORT_PIXELS = 16_777_216;
export const MAX_PAGE_EXPORT_PNG_BYTES = 96 * 1024 * 1024;
export const MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS =
  Math.ceil(MAX_PAGE_EXPORT_PNG_BYTES / 3) * 4;
export const MAX_PAGE_EXPORT_IMAGE_SOURCE_CHARS =
  MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS + 64;

export type PageExportRasterSize = {
  width: number;
  height: number;
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
  if (width > MAX_PAGE_EXPORT_SIDE_PX || height > MAX_PAGE_EXPORT_SIDE_PX) {
    return { valid: false, reason: "side-limit" };
  }
  if (width > Math.floor(MAX_PAGE_EXPORT_PIXELS / height)) {
    return { valid: false, reason: "pixel-limit" };
  }
  return { valid: true, pixelCount: width * height };
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
