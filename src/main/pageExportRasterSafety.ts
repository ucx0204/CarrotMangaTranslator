import { basename } from "node:path";
import {
  probeImageBuffer,
  probeImageFile,
  type ImageHeaderMetadata,
} from "./libraryStore/imageHeaderProbe";
import { tMain } from "./i18n";
import {
  MAX_PAGE_EXPORT_IMAGE_SOURCE_CHARS,
  MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES,
  MAX_PAGE_EXPORT_PNG_BYTES,
  MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS,
  PAGE_EXPORT_SOURCE_RASTER_LIMITS,
  SAFE_PAGE_EXPORT_RASTER_LIMITS,
  estimateBase64DecodedByteLength,
  pageExportRasterSizesEqual,
  validatePageExportRasterSize,
  type PageExportRasterLimits,
  type PageExportRasterSize,
} from "../shared/pageExportLimits";

const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";

type PageExportScreenshotDecodeLimits = {
  maxBase64Chars?: number;
  maxPngBytes?: number;
  rasterLimits?: PageExportRasterLimits;
};

export async function probePageExportSourceImage(
  imagePath: string,
  signal?: AbortSignal,
  limits: PageExportRasterLimits = SAFE_PAGE_EXPORT_RASTER_LIMITS,
): Promise<PageExportRasterSize> {
  const label = basename(imagePath);
  const metadata = await probeImageFile(
    imagePath,
    label,
    {
      maxWidth: PAGE_EXPORT_SOURCE_RASTER_LIMITS.maxSidePx,
      maxHeight: PAGE_EXPORT_SOURCE_RASTER_LIMITS.maxSidePx,
      maxPixels: PAGE_EXPORT_SOURCE_RASTER_LIMITS.maxPixels,
    },
    signal,
  );
  assertPageExportRasterBudget(metadata, label, limits);
  return { width: metadata.width, height: metadata.height };
}

export function assertPageExportRasterBudget(
  size: PageExportRasterSize,
  label: string,
  limits: PageExportRasterLimits = SAFE_PAGE_EXPORT_RASTER_LIMITS,
): number {
  const result = validatePageExportRasterSize(size, limits);
  if (!result.valid) {
    throw new Error(
      tMain("export.errors.rasterTooLarge", {
        name: label,
        width: String(size.width),
        height: String(size.height),
      }),
    );
  }
  return result.pixelCount;
}

export function buildBoundedPageExportDataUrl(
  bytes: Buffer,
  expected: PageExportRasterSize,
  label: string,
  rasterLimits: PageExportRasterLimits = SAFE_PAGE_EXPORT_RASTER_LIMITS,
): string {
  if (bytes.byteLength > MAX_PAGE_EXPORT_PNG_BYTES) {
    throw screenshotTooLargeError(label);
  }
  const metadata = probeImageBuffer(bytes, label, {
    maxWidth: rasterLimits.maxSidePx,
    maxHeight: rasterLimits.maxSidePx,
    maxPixels: rasterLimits.maxPixels,
  });
  assertPageExportRasterBudget(metadata, label, rasterLimits);
  if (!pageExportRasterSizesEqual(metadata, expected)) {
    throw new Error(
      tMain("export.errors.imageDimensionsChanged", {
        name: label,
      }),
    );
  }
  const encoded = bytes.toString("base64");
  const dataUrl = `data:${resolveImageMime(metadata.format)};base64,${encoded}`;
  if (dataUrl.length > MAX_PAGE_EXPORT_IMAGE_SOURCE_CHARS) {
    throw screenshotTooLargeError(label);
  }
  return dataUrl;
}

export function decodeBoundedPageExportScreenshot(
  data: string,
  expected: PageExportRasterSize,
  label: string,
  limits: PageExportScreenshotDecodeLimits = {},
): Buffer {
  const maxBase64Chars = Math.min(
    limits.maxBase64Chars ?? MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS,
    MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS,
  );
  const maxPngBytes = Math.min(
    limits.maxPngBytes ?? MAX_PAGE_EXPORT_PNG_BYTES,
    MAX_PAGE_EXPORT_PNG_BYTES,
  );
  const rasterLimits = limits.rasterLimits ?? SAFE_PAGE_EXPORT_RASTER_LIMITS;
  if (data.length < 1 || data.length > maxBase64Chars) {
    throw screenshotTooLargeError(label);
  }
  let estimated: number;
  try {
    estimated = estimateBase64DecodedByteLength(data);
  } catch (error) {
    throw invalidScreenshotError(error);
  }
  if (estimated > maxPngBytes) {
    throw screenshotTooLargeError(label);
  }
  const png = Buffer.from(data, "base64");
  if (png.byteLength !== estimated) {
    throw invalidScreenshotError();
  }
  assertPageExportPngBuffer(png, expected, label, maxPngBytes, rasterLimits);
  return png;
}

export function decodeBoundedPageExportImage(
  data: string,
  expected: PageExportRasterSize,
  label: string,
  expectedFormat: "jpeg" | "webp",
  limits: PageExportScreenshotDecodeLimits = {},
): Buffer {
  const maxBase64Chars = Math.min(
    limits.maxBase64Chars ?? MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS,
    MAX_PAGE_EXPORT_SCREENSHOT_BASE64_CHARS,
  );
  const maxBytes = Math.min(
    limits.maxPngBytes ?? MAX_PAGE_EXPORT_PNG_BYTES,
    MAX_PAGE_EXPORT_PNG_BYTES,
  );
  const rasterLimits = limits.rasterLimits ?? SAFE_PAGE_EXPORT_RASTER_LIMITS;
  if (data.length < 1 || data.length > maxBase64Chars) {
    throw screenshotTooLargeError(label);
  }
  let estimated: number;
  try {
    estimated = estimateBase64DecodedByteLength(data);
  } catch (error) {
    throw invalidScreenshotError(error);
  }
  if (estimated > maxBytes) throw screenshotTooLargeError(label);
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength !== estimated) throw invalidScreenshotError();
  const metadata = probeImageBuffer(bytes, label, {
    maxWidth: rasterLimits.maxSidePx,
    maxHeight: rasterLimits.maxSidePx,
    maxPixels: rasterLimits.maxPixels,
  });
  if (
    metadata.format !== expectedFormat ||
    !pageExportRasterSizesEqual(metadata, expected)
  ) {
    throw invalidScreenshotError();
  }
  return bytes;
}

export function assertPageExportPngBuffer(
  png: Buffer,
  expected: PageExportRasterSize | undefined,
  label: string,
  byteLimit = MAX_PAGE_EXPORT_PNG_BYTES,
  rasterLimits: PageExportRasterLimits = SAFE_PAGE_EXPORT_RASTER_LIMITS,
): PageExportRasterSize {
  const effectiveByteLimit = Math.min(
    byteLimit,
    MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES,
  );
  if (png.byteLength > effectiveByteLimit) {
    throw screenshotTooLargeError(label);
  }
  const actual = readPngRasterSize(png);
  assertPageExportRasterBudget(actual, label, rasterLimits);
  if (expected && !pageExportRasterSizesEqual(actual, expected)) {
    throw new Error(
      tMain("export.errors.outputDimensionsMismatch", {
        name: label,
        actual: `${actual.width}x${actual.height}`,
        expected: `${expected.width}x${expected.height}`,
      }),
    );
  }
  return actual;
}

export function assertPageExportImageBuffer(
  bytes: Buffer,
  expected: PageExportRasterSize,
  label: string,
  expectedFormat: "jpeg" | "webp",
  byteLimit = MAX_PAGE_EXPORT_PNG_BYTES,
  rasterLimits: PageExportRasterLimits = SAFE_PAGE_EXPORT_RASTER_LIMITS,
): PageExportRasterSize {
  const effectiveByteLimit = Math.min(
    byteLimit,
    MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES,
  );
  if (bytes.byteLength > effectiveByteLimit) {
    throw screenshotTooLargeError(label);
  }
  const metadata = probeImageBuffer(bytes, label, {
    maxWidth: rasterLimits.maxSidePx,
    maxHeight: rasterLimits.maxSidePx,
    maxPixels: rasterLimits.maxPixels,
  });
  assertPageExportRasterBudget(metadata, label, rasterLimits);
  if (metadata.format !== expectedFormat) {
    throw invalidScreenshotError();
  }
  const actual = { width: metadata.width, height: metadata.height };
  if (!pageExportRasterSizesEqual(actual, expected)) {
    throw new Error(
      tMain("export.errors.outputDimensionsMismatch", {
        name: label,
        actual: `${actual.width}x${actual.height}`,
        expected: `${expected.width}x${expected.height}`,
      }),
    );
  }
  return actual;
}

function readPngRasterSize(png: Buffer): PageExportRasterSize {
  if (
    png.length < 24 ||
    png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE_HEX ||
    png.readUInt32BE(8) !== 13 ||
    png.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw invalidScreenshotError();
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

function resolveImageMime(format: ImageHeaderMetadata["format"]): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
  }
}

function screenshotTooLargeError(label: string): Error {
  return new Error(
    tMain("export.errors.screenshotTooLarge", {
      name: label,
    }),
  );
}

function invalidScreenshotError(cause?: unknown): Error {
  return new Error(
    tMain("export.errors.invalidScreenshot"),
    cause === undefined ? undefined : { cause },
  );
}
