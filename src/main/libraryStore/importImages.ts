import { nativeImage } from "electron";
import { stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { getAppPaths } from "../appPaths";
import { tMain } from "./localization";
import { decodeImageThroughRuntime } from "../simplePageRuntime";
import { isSupportedImagePath, sortNaturally } from "./storage";
import { MAX_IMPORT_IMAGE_BYTES, MAX_IMPORT_IMAGE_PIXELS } from "./zipSafety";

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
