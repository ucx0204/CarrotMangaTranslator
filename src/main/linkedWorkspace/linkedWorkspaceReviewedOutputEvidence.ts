import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { parse, resolve } from "node:path";
import { hashStableValue } from "../../shared/blockFingerprint";
import { assertPathWithinRootWithoutSymlinks } from "../libraryStore/libraryTransactionStorage";
import { fingerprintBuffer, fingerprintFile } from "./linkedWorkspaceFiles";
import {
  ReviewedOutputError,
  type ReviewedOutputDigest,
} from "./linkedWorkspaceReviewedOutputTypes";

export function reviewedPathKey(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export async function assertReviewedPath(root: string, target: string) {
  try {
    if (resolve(root) !== parse(resolve(root)).root)
      await assertPathWithinRootWithoutSymlinks(
        parse(resolve(root)).root,
        root,
      );
    await assertPathWithinRootWithoutSymlinks(root, target, {
      allowMissingTarget: true,
    });
  } catch (error) {
    throw new ReviewedOutputError("unsafe_path", { cause: error });
  }
}

export async function reviewedRootIdentity(root: string): Promise<string> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new ReviewedOutputError("unsafe_path");
  return hashStableValue({
    path: reviewedPathKey(await realpath(root)),
    device: metadata.dev,
    inode: metadata.ino,
    created: metadata.birthtimeMs,
  });
}

export async function readReviewedFile(
  path: string,
  allowMissing = false,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Promise<ReviewedOutputDigest | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new ReviewedOutputError("unsafe_path");
    if (metadata.size > maximumBytes)
      throw new ReviewedOutputError("limit_exceeded");
    const value = await fingerprintFile(path, maximumBytes);
    const latest = await lstat(path);
    assertFileFingerprintSnapshot(metadata, latest, value.size);
    return { bytes: value.size, sha256: value.sha256 };
  } catch (error) {
    if (allowMissing && isMissing(error)) return null;
    if (error instanceof RangeError)
      throw new ReviewedOutputError("limit_exceeded", { cause: error });
    throw error;
  }
}

function assertFileFingerprintSnapshot(
  initial: Stats,
  latest: Stats,
  bytes: number,
) {
  if (
    !latest.isFile() ||
    latest.isSymbolicLink() ||
    latest.size !== initial.size ||
    latest.mtimeMs !== initial.mtimeMs ||
    latest.ino !== initial.ino ||
    bytes !== initial.size
  )
    throw new ReviewedOutputError("source_changed");
}

/** Read, fingerprint, and parse the same bounded bytes from one open file. */
export async function readReviewedJson(path: string, maximumBytes: number) {
  const initial = await readReviewedFileMetadata(path);
  if (!initial) return null;
  if (initial.size > maximumBytes)
    throw new ReviewedOutputError("limit_exceeded");
  const handle = await open(path, "r");
  const outcome = await readOpenReviewedJson(
    handle,
    path,
    initial,
    maximumBytes,
  ).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await handle.close();
  } catch (error) {
    if (!outcome.ok)
      throw new AggregateError(
        [outcome.error, error],
        "Reviewed JSON read and cleanup failed.",
        { cause: error },
      );
    throw error;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

async function readOpenReviewedJson(
  handle: FileHandle,
  path: string,
  initial: Stats,
  maximumBytes: number,
) {
  const metadata = await handle.stat();
  assertMetadataSnapshot(initial, metadata);
  const content = await readBoundedBytes(handle, metadata.size, maximumBytes);
  const latest = await readReviewedFileMetadata(path);
  assertMetadataSnapshot(metadata, latest);
  if (content.byteLength !== metadata.size)
    throw new ReviewedOutputError("source_changed");
  return {
    digest: { bytes: content.byteLength, sha256: fingerprintBuffer(content) },
    value: JSON.parse(content.toString("utf8")) as unknown,
  };
}

function assertMetadataSnapshot(initial: Stats, latest: Stats | null) {
  if (
    !latest ||
    !latest.isFile() ||
    latest.ino !== initial.ino ||
    latest.dev !== initial.dev ||
    latest.size !== initial.size ||
    latest.mtimeMs !== initial.mtimeMs
  )
    throw new ReviewedOutputError("source_changed");
}

async function readBoundedBytes(
  handle: FileHandle,
  size: number,
  maximumBytes: number,
) {
  const content = Buffer.alloc(Math.min(size + 1, maximumBytes + 1));
  let bytes = 0;
  while (bytes < content.length) {
    const result = await handle.read(
      content,
      bytes,
      content.length - bytes,
      bytes,
    );
    if (result.bytesRead === 0) break;
    bytes += result.bytesRead;
  }
  if (bytes > maximumBytes) throw new ReviewedOutputError("limit_exceeded");
  return content.subarray(0, bytes);
}

async function readReviewedFileMetadata(path: string) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new ReviewedOutputError("unsafe_path");
    return metadata;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function sameReviewedDigest(
  left: ReviewedOutputDigest | null,
  right: ReviewedOutputDigest | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.bytes === right.bytes && left.sha256 === right.sha256;
}

export function assertReviewedDigest(
  actual: ReviewedOutputDigest | null,
  expected: ReviewedOutputDigest | null,
) {
  if (!sameReviewedDigest(actual, expected))
    throw new ReviewedOutputError("source_changed");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
