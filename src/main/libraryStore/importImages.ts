import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { throwIfAborted } from "../abortSignal";
import {
  IMPORT_IMAGE_DECODE_TIMEOUT_MS,
  MAX_NORMALIZED_IMAGE_BYTES,
} from "./imageDecodeLimits";
import {
  assertImageDimensionsWithinBudget,
  assertSameImageDimensions,
  DEFAULT_IMPORT_IMAGE_HEADER_LIMITS,
  probeImageFile,
  type ImageHeaderMetadata,
  type ImportImageFormat,
} from "./imageHeaderProbe";
import { tMain } from "./localization";
import {
  productionImportImageRuntime,
  type ImportImageConversionOptions,
  type ImportImageRuntime,
  type ImportImageValidationOptions,
} from "./importImageRuntime";
import { isSupportedImagePath, sortNaturally } from "./storage";
import { MAX_IMPORT_IMAGE_BYTES, MAX_IMPORT_IMAGE_PIXELS } from "./zipSafety";

const IMPORT_IMAGE_SIGNATURE_BYTES = 12;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const;

export async function filterImportImageFiles(
  filePaths: string[],
): Promise<string[]> {
  const normalized = sortNaturally(
    filePaths.filter((filePath) => isSupportedImagePath(filePath)),
  );
  for (const filePath of normalized) {
    await assertImportImageFileBudget(filePath);
    await probeImageFile(filePath, basename(filePath));
  }
  return normalized;
}

export async function assertImportImageFileBudget(
  filePath: string,
): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error(
      tMain("import.errors.imageRead", { file: basename(filePath) }),
    );
  }
  if (info.size > MAX_IMPORT_IMAGE_BYTES) {
    throw new Error(
      tMain("import.errors.fileTooLarge", { file: basename(filePath) }),
    );
  }
}

export function detectImportImageFormat(
  bytes: Uint8Array,
): ImportImageFormat | null {
  if (matchesSignature(bytes, JPEG_SIGNATURE)) {
    return "jpeg";
  }
  if (matchesSignature(bytes, PNG_SIGNATURE)) {
    return "png";
  }
  if (
    bytes.length >= IMPORT_IMAGE_SIGNATURE_BYTES &&
    matchesSignature(bytes, RIFF_SIGNATURE) &&
    matchesSignature(bytes, WEBP_SIGNATURE, 8)
  ) {
    return "webp";
  }
  return null;
}

function matchesSignature(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((value, index) => bytes[offset + index] === value);
}

export async function convertValidatedWebpImportImage({
  sourcePath,
  outputPath,
  sourceMetadata,
  label,
  runtime = productionImportImageRuntime,
  signal,
}: {
  sourcePath: string;
  outputPath: string;
  sourceMetadata: ImageHeaderMetadata;
  label: string;
  runtime?: ImportImageRuntime;
  signal?: AbortSignal;
}): Promise<ImageHeaderMetadata> {
  throwIfAborted(signal);
  const conversionOptions: ImportImageConversionOptions = {
    maxPixels: MAX_IMPORT_IMAGE_PIXELS,
    maxOutputBytes: MAX_NORMALIZED_IMAGE_BYTES,
    timeoutMs: IMPORT_IMAGE_DECODE_TIMEOUT_MS,
    signal,
  };
  await runtime.convertWebpToPngFile(sourcePath, outputPath, conversionOptions);
  throwIfAborted(signal);
  return validateStoredImportImage({
    imagePath: outputPath,
    expected: sourceMetadata,
    label,
    runtime,
    signal,
  });
}

export async function validateStoredImportImage({
  imagePath,
  expected,
  label,
  runtime = productionImportImageRuntime,
  signal,
}: {
  imagePath: string;
  expected: ImageHeaderMetadata;
  label: string;
  runtime?: ImportImageRuntime;
  signal?: AbortSignal;
}): Promise<ImageHeaderMetadata> {
  throwIfAborted(signal);
  const actual = await probeImageFile(
    imagePath,
    label,
    DEFAULT_IMPORT_IMAGE_HEADER_LIMITS,
    signal,
  );
  assertImageDimensionsWithinBudget(actual, label);
  assertSameImageDimensions(
    expected,
    actual,
    tMain("import.errors.imageDimensionsChanged", { file: label }),
  );
  const validationOptions: ImportImageValidationOptions = {
    maxPixels: MAX_IMPORT_IMAGE_PIXELS,
    timeoutMs: IMPORT_IMAGE_DECODE_TIMEOUT_MS,
    signal,
  };
  await runtime.validateImageFile(imagePath, validationOptions);
  throwIfAborted(signal);
  return actual;
}

export function normalizeImportPageName(entryName: string): string {
  return entryName.replace(/\\/g, "/");
}
