import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
type RemoteFileMetadata = {
  url: string;
  bytes: number;
  downloadedAt: string;
  mtimeMs?: number;
  sha256?: string;
};

type Dirent = import("node:fs").Dirent;

export function safeReadDir(dir: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
}

export function findFirstFileRecursive(
  root: string,
  lowerCaseNames: Set<string>,
  maxDepth: number,
): string | null {
  let match: string | null = null;
  walkFilesBreadthFirst(root, maxDepth, (entry, fullPath) => {
    if (!entry.isFile() || !lowerCaseNames.has(entry.name.toLowerCase())) {
      return false;
    }
    match = fullPath;
    return true;
  });
  return match;
}

export function findFilesRecursive(
  root: string,
  predicate: (entry: Dirent, fullPath: string) => boolean,
  maxDepth: number,
  limit: number,
): string[] {
  const results: string[] = [];
  if (limit <= 0) return results;
  walkFilesBreadthFirst(root, maxDepth, (entry, fullPath) =>
    appendMatchingFile(results, limit, entry, fullPath, predicate),
  );
  return results;
}

function walkFilesBreadthFirst(
  root: string,
  maxDepth: number,
  visit: (entry: Dirent, fullPath: string) => boolean,
): void {
  if (!directoryExists(root)) return;
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (!current) continue;
    for (const entry of safeReadDir(current.dir)) {
      const fullPath = join(current.dir, entry.name);
      if (visit(entry, fullPath)) return;
      if (
        entry.isDirectory() &&
        current.depth < maxDepth &&
        !["__pycache__", ".git"].includes(entry.name)
      ) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }
}

function appendMatchingFile(
  results: string[],
  limit: number,
  entry: Dirent,
  fullPath: string,
  predicate: (entry: Dirent, fullPath: string) => boolean,
): boolean {
  if (!predicate(entry, fullPath)) {
    return false;
  }
  results.push(fullPath);
  return results.length >= limit;
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function uniqueExistingDirs(paths: string[]): string[] {
  return uniquePaths(paths).filter(directoryExists);
}

export function uniquePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawPath of paths) {
    const value = rawPath?.trim();
    if (!value) {
      continue;
    }
    const normalized = resolve(value);
    const key =
      process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function readChildDirectories(root: string): string[] {
  try {
    return readdirSync(root)
      .map((name) => ({ name, path: join(root, name) }))
      .filter((entry) => directoryExists(entry.path))
      .map((entry) => entry.name);
  } catch (_error) {
    return [];
  }
}

export function compareVersionDesc(left: string, right: string): number {
  return compareVersionStrings(right, left);
}

function compareVersionStrings(left: string, right: string): number {
  const leftParts = left
    .split(/[^\d]+/)
    .filter(Boolean)
    .map(Number);
  const rightParts = right
    .split(/[^\d]+/)
    .filter(Boolean)
    .map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return left.localeCompare(right);
}

export function pathListContainsFile(
  paths: string[],
  fileName: string,
): boolean {
  return paths.some((dir) => fileExists(join(dir, fileName)));
}

export function findFileInPathList(
  paths: string[],
  fileName: string,
): string | null {
  for (const dir of paths) {
    const candidate = join(dir, fileName);
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function directoryExists(pathValue: string): boolean {
  try {
    return statSync(pathValue).isDirectory();
  } catch (_error) {
    return false;
  }
}

export function fileExists(pathValue: string): boolean {
  try {
    return statSync(pathValue).isFile();
  } catch (_error) {
    return false;
  }
}

export function isUsableFile(
  filePath: string,
  minimumBytes = 1024 * 1024,
): boolean {
  try {
    return (
      existsSync(filePath) &&
      statSync(filePath).isFile() &&
      statSync(filePath).size >= minimumBytes
    );
  } catch (_error) {
    return false;
  }
}

export async function isUsableRemoteFile(
  filePath: string,
  url: string,
  options: { expectedSha256?: string; minimumBytes?: number } = {},
): Promise<boolean> {
  const minimumBytes = options.minimumBytes ?? 1024 * 1024;
  if (!isUsableFile(filePath, minimumBytes)) {
    return false;
  }
  const metadata = await readRemoteFileMetadata(filePath);
  try {
    const fileStat = statSync(filePath);
    const expectedSha256 = options.expectedSha256?.toLowerCase();
    if (!expectedSha256) {
      return metadata
        ? remoteFileMetadataMatches(metadata, url, fileStat.size, minimumBytes)
        : true;
    }
    if (
      metadata &&
      remoteFileMetadataMatches(
        metadata,
        url,
        fileStat.size,
        minimumBytes,
        expectedSha256,
      ) &&
      metadata.mtimeMs === fileStat.mtimeMs
    ) {
      return true;
    }
    return await verifyRemoteFileHash(
      filePath,
      url,
      expectedSha256,
      fileStat,
      metadata,
    );
  } catch (_error) {
    return false;
  }
}

function remoteFileMetadataMatches(
  metadata: RemoteFileMetadata,
  url: string,
  actualBytes: number,
  minimumBytes: number,
  expectedSha256?: string,
): boolean {
  return (
    metadata.url === url &&
    metadata.bytes === actualBytes &&
    actualBytes >= minimumBytes &&
    (!expectedSha256 || metadata.sha256?.toLowerCase() === expectedSha256)
  );
}

async function verifyRemoteFileHash(
  filePath: string,
  url: string,
  expectedSha256: string,
  fileStat: { size: number; mtimeMs: number },
  metadata: RemoteFileMetadata | null,
): Promise<boolean> {
  if ((await sha256File(filePath)) !== expectedSha256) {
    return false;
  }
  try {
    await writeRemoteFileMetadata(filePath, {
      url,
      bytes: fileStat.size,
      downloadedAt: metadata?.downloadedAt ?? new Date().toISOString(),
      mtimeMs: fileStat.mtimeMs,
      sha256: expectedSha256,
    });
  } catch (_error) {
    // error-policy-allow: verified bytes remain usable; a missing marker only
    // causes another checksum pass on the next launch.
  }
  return true;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function readRemoteFileMetadata(
  filePath: string,
): Promise<RemoteFileMetadata | null> {
  try {
    return JSON.parse(
      await readFile(remoteFileMetadataPath(filePath), "utf8"),
    ) as RemoteFileMetadata;
  } catch (_error) {
    return null;
  }
}

export async function writeRemoteFileMetadata(
  filePath: string,
  metadata: RemoteFileMetadata,
): Promise<void> {
  const metadataPath = remoteFileMetadataPath(filePath);
  const temporaryPath = join(
    dirname(metadataPath),
    `.m-${randomBytes(8).toString("hex")}`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, metadataPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function remoteFileMetadataPath(filePath: string): string {
  return `${filePath}.mgtmeta.json`;
}

export function isExecutableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch (_error) {
    return false;
  }
}

export function sha256FileSync(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}
