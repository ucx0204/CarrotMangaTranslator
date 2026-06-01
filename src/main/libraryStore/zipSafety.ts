import { isSupportedImagePath } from "./storage";

export type ZipEntryLike = {
  entryName: string;
  isDirectory: boolean;
  header?: {
    size?: number;
    compressedSize?: number;
  };
  getData: () => Buffer;
};

export type AdmZipLike = {
  getEntries: () => ZipEntryLike[];
  addFile: (entryName: string, content: Buffer | string) => void;
  writeZip: (targetPath: string) => void;
};

export const MAX_ZIP_ENTRY_COUNT = 10000;
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_SHARE_JSON_BYTES = 20 * 1024 * 1024;
export const MAX_SHARE_IMAGE_BYTES = 128 * 1024 * 1024;
export const MAX_IMPORT_IMAGE_BYTES = 256 * 1024 * 1024;

export const AdmZip = require("adm-zip") as {
  new (archivePath?: string): AdmZipLike;
};

export function buildSafeShareEntryMap(zipEntries: ZipEntryLike[]): Map<string, ZipEntryLike> {
  assertZipEntryBudget(zipEntries, "공유 파일");
  const entries = new Map<string, ZipEntryLike>();
  for (const entry of zipEntries) {
    const normalized = normalizeShareEntryName(entry.entryName, entry.isDirectory);
    if (!normalized || entry.isDirectory) {
      continue;
    }
    if (entries.has(normalized)) {
      throw new Error(`공유 파일에 중복 항목이 있습니다: ${normalized}`);
    }
    entries.set(normalized, entry);
  }
  return entries;
}

export function normalizeShareRelativePath(path: string, message: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(message);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(message);
  }
  return parts.join("/");
}

export function normalizeSharePathSegment(value: string, message: string): string {
  if (!value || value.includes("\0") || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error(message);
  }
  return value;
}

export function assertZipEntryBudget(entries: ZipEntryLike[], label: string): void {
  if (entries.length > MAX_ZIP_ENTRY_COUNT) {
    throw new Error(`${label} 항목이 너무 많습니다.`);
  }

  let totalBytes = 0;
  for (const entry of entries) {
    const size = getZipEntrySize(entry);
    if (size === null) {
      continue;
    }
    totalBytes += size;
    if (totalBytes > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(`${label} 압축 해제 크기가 너무 큽니다.`);
    }
  }
}

export function assertZipEntrySize(entry: ZipEntryLike, maxBytes: number, label: string): void {
  const size = getZipEntrySize(entry);
  if (size !== null && size > maxBytes) {
    throw new Error(`${label} 파일이 너무 큽니다.`);
  }
}

export function readZipEntryData(entry: ZipEntryLike, maxBytes: number, label: string): Buffer {
  assertZipEntrySize(entry, maxBytes, label);
  const data = entry.getData();
  if (data.byteLength > maxBytes) {
    throw new Error(`${label} 파일이 너무 큽니다.`);
  }
  return data;
}

function normalizeShareEntryName(entryName: string, isDirectory: boolean): string | null {
  const raw = entryName.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!raw && isDirectory) {
    return null;
  }
  return normalizeShareRelativePath(raw, "공유 파일에 안전하지 않은 경로가 있습니다.");
}

function getZipEntrySize(entry: ZipEntryLike): number | null {
  const size = Number(entry.header?.size);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

export function isSupportedShareImagePath(filePath: string): boolean {
  return isSupportedImagePath(filePath);
}
