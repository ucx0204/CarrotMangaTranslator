import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { assertImportImageFileBudget } from "./importImages";
import { isSupportedImagePath, sortNaturally } from "./storage";
import {
  MAX_IMPORT_IMAGE_BYTES,
  assertZipEntryBudget,
  assertZipEntrySize,
  readZipEntries,
  type ZipEntryLike,
} from "./zipSafety";

const MAX_NESTED_IMAGE_FOLDER_DEPTH = 8;
const MAX_NESTED_IMAGE_FOLDERS = 500;
const MAX_NESTED_IMAGE_FOLDER_PAGES = 5000;
export const SUPPORTED_ARCHIVE_EXTENSIONS = [".zip", ".cbz"] as const;

export function isSupportedArchivePath(filePath: string): boolean {
  return SUPPORTED_ARCHIVE_EXTENSIONS.includes(
    extname(
      filePath,
    ).toLowerCase() as (typeof SUPPORTED_ARCHIVE_EXTENSIONS)[number],
  );
}

export async function listImageFiles(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const filePaths = sortNaturally(
    entries
      .filter((entry) => entry.isFile() && isSupportedImagePath(entry.name))
      .map((entry) => join(folderPath, entry.name)),
  );
  await Promise.all(
    filePaths.map((filePath) => assertImportImageFileBudget(filePath)),
  );
  return filePaths;
}

export async function listZipFiles(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  return sortNaturally(
    entries
      .filter((entry) => entry.isFile() && isSupportedArchivePath(entry.name))
      .map((entry) => join(folderPath, entry.name)),
  );
}

export async function listNestedImageFolders(
  rootPath: string,
): Promise<string[]> {
  const found: string[] = [];
  let discoveredPages = 0;

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (depth > MAX_NESTED_IMAGE_FOLDER_DEPTH) {
      return;
    }
    const entries = await readdir(currentPath, { withFileTypes: true });
    const childDirectories = sortNaturally(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(currentPath, entry.name)),
    );
    const imageCount = entries.filter(
      (entry) => entry.isFile() && isSupportedImagePath(entry.name),
    ).length;

    if (currentPath !== rootPath && imageCount > 0) {
      discoveredPages += imageCount;
      if (
        found.length >= MAX_NESTED_IMAGE_FOLDERS ||
        discoveredPages > MAX_NESTED_IMAGE_FOLDER_PAGES
      ) {
        throw new Error("가져올 폴더 또는 이미지가 너무 많습니다.");
      }
      found.push(currentPath);
    }

    for (const childPath of childDirectories) {
      await walk(childPath, depth + 1);
    }
  }

  await walk(rootPath, 0);
  return found;
}

export async function listImageEntriesInZip(
  zipPath: string,
): Promise<ZipEntryLike[]> {
  const entries = await readZipEntries(zipPath, "ZIP 파일");
  assertZipEntryBudget(entries, "ZIP 파일");
  const imageEntries = entries
    .filter(
      (entry) => !entry.isDirectory && isSupportedImagePath(entry.entryName),
    )
    .sort((left, right) =>
      left.entryName.localeCompare(right.entryName, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  for (const entry of imageEntries) {
    assertZipEntrySize(entry, MAX_IMPORT_IMAGE_BYTES, entry.entryName);
  }
  return imageEntries;
}
