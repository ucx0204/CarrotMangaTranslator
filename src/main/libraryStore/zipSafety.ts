import { Readable } from "node:stream";
import * as yauzl from "yauzl";

export type ZipEntryLike = {
  entryName: string;
  isDirectory: boolean;
  header?: {
    size?: number;
    compressedSize?: number;
  };
  getData?: () => Buffer;
};

export type AdmZipLike = {
  getEntries: () => ZipEntryLike[];
  addFile: (entryName: string, content: Buffer | string) => void;
  writeZip: (targetPath: string) => void;
};

type OpenZipEntry = ZipEntryLike & {
  rawEntry: yauzl.Entry;
};

export type ZipArchiveReader = {
  entries: ZipEntryLike[];
  entryMap: Map<string, ZipEntryLike>;
  readEntry: (entryName: string, maxBytes: number, label: string) => Promise<Buffer>;
  close: () => void;
};

export const MAX_ZIP_ENTRY_COUNT = 10000;
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_SHARE_JSON_BYTES = 20 * 1024 * 1024;
export const MAX_SHARE_IMAGE_BYTES = 128 * 1024 * 1024;
export const MAX_IMPORT_IMAGE_BYTES = 256 * 1024 * 1024;
export const MAX_IMPORT_IMAGE_PIXELS = 120_000_000;
export const MAX_ZIP_COMPRESSION_RATIO = 100;

export const AdmZip = require("adm-zip") as {
  new (archivePath?: string): AdmZipLike;
};

export async function openZipEntryMap(
  archivePath: string,
  label: string,
): Promise<Map<string, ZipEntryLike>> {
  const entries = await readZipEntries(archivePath, label);
  const entryMap = new Map<string, ZipEntryLike>();
  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }
    if (entryMap.has(entry.entryName)) {
      throw new Error(`${label}에 중복 항목이 있습니다: ${entry.entryName}`);
    }
    entryMap.set(entry.entryName, entry);
  }
  return entryMap;
}

export async function openZipArchiveReader(
  archivePath: string,
  label: string,
): Promise<ZipArchiveReader> {
  const zipFile = await yauzl.openPromise(archivePath, {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  let closed = false;
  try {
    const openEntries: OpenZipEntry[] = [];
    for await (const entry of zipFile.eachEntry()) {
      openEntries.push(toOpenZipEntry(entry));
    }
    assertZipEntryBudget(openEntries, label);

    const rawEntryMap = new Map<string, OpenZipEntry>();
    const entryMap = new Map<string, ZipEntryLike>();
    for (const entry of openEntries) {
      if (entry.isDirectory) {
        continue;
      }
      if (rawEntryMap.has(entry.entryName)) {
        throw new Error(`${label}에 중복 항목이 있습니다: ${entry.entryName}`);
      }
      rawEntryMap.set(entry.entryName, entry);
      entryMap.set(entry.entryName, stripOpenZipEntry(entry));
    }

    return {
      entries: openEntries.map(stripOpenZipEntry),
      entryMap,
      readEntry: async (entryName, maxBytes, entryLabel) => {
        const entry = rawEntryMap.get(entryName);
        if (!entry || entry.isDirectory) {
          throw new Error(`${entryLabel} 파일을 찾지 못했습니다.`);
        }
        assertZipEntrySize(entry, maxBytes, entryLabel);
        const stream = await zipFile.openReadStreamPromise(entry.rawEntry);
        return readLimitedStream(stream, maxBytes, entryLabel);
      },
      close: () => {
        if (!closed) {
          closed = true;
          zipFile.close();
        }
      },
    };
  } catch (error) {
    if (!closed) {
      closed = true;
      zipFile.close();
    }
    throw error;
  }
}

export async function readZipEntries(
  archivePath: string,
  label: string,
): Promise<ZipEntryLike[]> {
  const zipFile = await yauzl.openPromise(archivePath, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    const entries: ZipEntryLike[] = [];
    for await (const entry of zipFile.eachEntry()) {
      entries.push(toZipEntryLike(entry));
    }
    assertZipEntryBudget(entries, label);
    return entries;
  } finally {
    zipFile.close();
  }
}

export function buildSafeShareEntryMap(
  zipEntries: ZipEntryLike[],
): Map<string, ZipEntryLike> {
  assertZipEntryBudget(zipEntries, "공유 파일");
  const entries = new Map<string, ZipEntryLike>();
  for (const entry of zipEntries) {
    const normalized = normalizeShareEntryName(
      entry.entryName,
      entry.isDirectory,
    );
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

export function normalizeShareRelativePath(
  path: string,
  message: string,
): string {
  const normalized = path.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(message);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(message);
  }
  return parts.join("/");
}

export function normalizeSharePathSegment(
  value: string,
  message: string,
): string {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(message);
  }
  return value;
}

export function assertZipEntryBudget(
  entries: ZipEntryLike[],
  label: string,
): void {
  if (entries.length > MAX_ZIP_ENTRY_COUNT) {
    throw new Error(`${label} 항목이 너무 많습니다.`);
  }

  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }
    const size = getRequiredZipEntrySize(entry, entry.entryName);
    assertZipCompressionRatio(entry, size, entry.entryName);
    totalBytes += size;
    if (totalBytes > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(`${label} 압축 해제 크기가 너무 큽니다.`);
    }
  }
}

export function assertZipEntrySize(
  entry: ZipEntryLike,
  maxBytes: number,
  label: string,
): void {
  const size = getRequiredZipEntrySize(entry, label);
  assertZipCompressionRatio(entry, size, label);
  if (size > maxBytes) {
    throw new Error(`${label} 파일이 너무 큽니다.`);
  }
}

export function readZipEntryData(
  entry: ZipEntryLike,
  maxBytes: number,
  label: string,
): Buffer {
  assertZipEntrySize(entry, maxBytes, label);
  if (!entry.getData) {
    throw new Error(`${label} 파일을 스트리밍 방식으로 읽어야 합니다.`);
  }
  const data = entry.getData();
  if (data.byteLength > maxBytes) {
    throw new Error(`${label} 파일이 너무 큽니다.`);
  }
  return data;
}

export async function readZipEntryDataFromFile(
  archivePath: string,
  entryName: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const zipFile = await yauzl.openPromise(archivePath, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    for await (const yauzlEntry of zipFile.eachEntry()) {
      if (yauzlEntry.fileName !== entryName) {
        continue;
      }
      const entry = toZipEntryLike(yauzlEntry);
      if (entry.isDirectory) {
        throw new Error(`${label} 파일을 찾지 못했습니다.`);
      }
      assertZipEntrySize(entry, maxBytes, label);
      const stream = await zipFile.openReadStreamPromise(yauzlEntry);
      return await readLimitedStream(stream, maxBytes, label);
    }
    throw new Error(`${label} 파일을 찾지 못했습니다.`);
  } finally {
    zipFile.close();
  }
}

function normalizeShareEntryName(
  entryName: string,
  isDirectory: boolean,
): string | null {
  const raw = entryName.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!raw && isDirectory) {
    return null;
  }
  return normalizeShareRelativePath(
    raw,
    "공유 파일에 안전하지 않은 경로가 있습니다.",
  );
}

function getZipEntrySize(entry: ZipEntryLike): number | null {
  const size = Number(entry.header?.size);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

function getRequiredZipEntrySize(entry: ZipEntryLike, label: string): number {
  const size = getZipEntrySize(entry);
  if (size === null) {
    throw new Error(`${label} 압축 해제 크기를 확인할 수 없습니다.`);
  }
  return size;
}

function assertZipCompressionRatio(
  entry: ZipEntryLike,
  size: number,
  label: string,
): void {
  const compressedSize = Number(entry.header?.compressedSize);
  if (!Number.isFinite(compressedSize) || compressedSize < 0) {
    throw new Error(`${label} 압축 크기를 확인할 수 없습니다.`);
  }
  if (compressedSize === 0) {
    if (size > 0) {
      throw new Error(`${label} 압축 정보가 올바르지 않습니다.`);
    }
    return;
  }
  if (size / compressedSize > MAX_ZIP_COMPRESSION_RATIO) {
    throw new Error(`${label} 압축률이 비정상적으로 높습니다.`);
  }
}

function toZipEntryLike(entry: yauzl.Entry): ZipEntryLike {
  return {
    entryName: entry.fileName,
    isDirectory: entry.fileName.endsWith("/"),
    header: {
      size: entry.uncompressedSize,
      compressedSize: entry.compressedSize,
    },
  };
}

function toOpenZipEntry(entry: yauzl.Entry): OpenZipEntry {
  return {
    ...toZipEntryLike(entry),
    rawEntry: entry,
  };
}

function stripOpenZipEntry(entry: ZipEntryLike): ZipEntryLike {
  return {
    entryName: entry.entryName,
    isDirectory: entry.isDirectory,
    header: entry.header,
  };
}

async function readLimitedStream(
  stream: Readable,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      stream.destroy();
      throw new Error(`${label} 파일이 너무 큽니다.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}
