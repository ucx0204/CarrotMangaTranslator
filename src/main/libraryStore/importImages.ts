import { nativeImage } from "electron";
import { open, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { getAppPaths } from "../appPaths";
import { tMain } from "./localization";
import { decodeImageThroughRuntime } from "../simplePageRuntime";
import { isSupportedImagePath, sortNaturally } from "./storage";
import { MAX_IMPORT_IMAGE_BYTES, MAX_IMPORT_IMAGE_PIXELS } from "./zipSafety";

export type ImportImageFormat = "jpeg" | "png" | "webp";

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
  await Promise.all(
    normalized.map((filePath) => assertImportImageFileBudget(filePath)),
  );
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

export function shouldNormalizeImportImageToPng(ext: string): boolean {
  return ext.toLowerCase() === ".webp";
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

export async function detectImportImageFormatFromFile(
  filePath: string,
): Promise<ImportImageFormat | null> {
  const file = await open(filePath, "r");
  try {
    const header = Buffer.alloc(IMPORT_IMAGE_SIGNATURE_BYTES);
    const { bytesRead } = await file.read(
      header,
      0,
      IMPORT_IMAGE_SIGNATURE_BYTES,
      0,
    );
    return detectImportImageFormat(header.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

export async function writeNormalizedWebpImportImage(
  sourcePath: string,
  outputPath: string,
  label: string,
): Promise<void> {
  const converted = await decodeImageThroughRuntime(
    getAppPaths().runtimeDir,
    sourcePath,
  );
  if (!converted?.length) {
    throw new Error(tMain("import.errors.webpConvert", { file: label }));
  }

  await writeFile(outputPath, converted);
}

export async function readDecodedImportImageSize(
  imagePath: string,
  label: string,
): Promise<{ width: number; height: number }> {
  const image = nativeImage.createFromPath(imagePath);
  const size = image.getSize();
  const isEmpty = typeof image.isEmpty === "function" ? image.isEmpty() : false;
  if (
    isEmpty ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width < 1 ||
    size.height < 1
  ) {
    throw new Error(tMain("import.errors.imageRead", { file: label }));
  }
  if (size.width * size.height > MAX_IMPORT_IMAGE_PIXELS) {
    throw new Error(tMain("import.errors.resolutionTooLarge", { file: label }));
  }
  return size;
}

export function normalizeImportPageName(entryName: string): string {
  return entryName.replace(/\\/g, "/");
}
