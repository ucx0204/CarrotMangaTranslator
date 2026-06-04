import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { assertImportImageFileBudget } from "./importImages";
import { isSupportedImagePath, sortNaturally } from "./storage";
import {
  AdmZip,
  MAX_IMPORT_IMAGE_BYTES,
  assertZipEntryBudget,
  assertZipEntrySize,
  type ZipEntryLike
} from "./zipSafety";

export async function listImageFiles(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const filePaths = sortNaturally(
    entries.filter((entry) => entry.isFile() && isSupportedImagePath(entry.name)).map((entry) => join(folderPath, entry.name))
  );
  await Promise.all(filePaths.map((filePath) => assertImportImageFileBudget(filePath)));
  return filePaths;
}

export async function listZipFiles(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  return sortNaturally(
    entries.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".zip").map((entry) => join(folderPath, entry.name))
  );
}

export async function listNestedImageFolders(rootPath: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    const childDirectories = sortNaturally(entries.filter((entry) => entry.isDirectory()).map((entry) => join(currentPath, entry.name)));

    if (currentPath !== rootPath && entries.some((entry) => entry.isFile() && isSupportedImagePath(entry.name))) {
      found.push(currentPath);
    }

    for (const childPath of childDirectories) {
      await walk(childPath);
    }
  }

  await walk(rootPath);
  return found;
}

export function listImageEntriesInZip(zipPath: string): ZipEntryLike[] {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  assertZipEntryBudget(entries, "ZIP 파일");
  const imageEntries = entries
    .filter((entry) => !entry.isDirectory && isSupportedImagePath(entry.entryName))
    .sort((left, right) => left.entryName.localeCompare(right.entryName, undefined, { numeric: true, sensitivity: "base" }));
  for (const entry of imageEntries) {
    assertZipEntrySize(entry, MAX_IMPORT_IMAGE_BYTES, entry.entryName);
  }
  return imageEntries;
}
