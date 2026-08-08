/* eslint-disable complexity -- path ancestry and filesystem state checks are intentionally exhaustive for transaction safety */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { logLibraryWarning } from "./libraryLogger";
import { renameWithTransientRetry } from "./storage";
import { MAX_LIBRARY_TRANSACTION_JOURNAL_BYTES } from "./libraryTransactionSchema";

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EINVAL",
  "ENOTSUP",
  "ENOSYS",
  "EPERM",
  "EISDIR",
  "EBADF",
]);
const warnedUnsupportedDirectorySyncCodes = new Set<string>();

export async function writeDurableJsonFile(
  path: string,
  payload: unknown,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeDurableFile(path, bytes);
}

export async function writeDurableFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx");
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithTransientRetry(tempPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        logLibraryWarning(
          "Failed to close transaction temp file after write failure",
          {
            path: tempPath,
            error: closeError,
          },
        );
      }
    }
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (!isErrnoCode(cleanupError, "ENOENT")) {
        throwCleanupFailure(
          error,
          cleanupError,
          `durable file write와 temp cleanup이 모두 실패했습니다: ${path}`,
        );
      }
    }
    throw error;
  }
}

function throwCleanupFailure(
  primaryError: unknown,
  cleanupError: unknown,
  message: string,
): never {
  throw new AggregateError([primaryError, cleanupError], message, {
    cause: primaryError,
  });
}

export async function readBoundedJsonFile(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`transaction journal이 regular file이 아닙니다: ${path}`);
  }
  if (stat.size > MAX_LIBRARY_TRANSACTION_JOURNAL_BYTES) {
    throw new Error(`transaction journal이 허용 크기를 초과했습니다: ${path}`);
  }
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_LIBRARY_TRANSACTION_JOURNAL_BYTES) {
    throw new Error(`transaction journal이 허용 크기를 초과했습니다: ${path}`);
  }
  return JSON.parse(raw) as unknown;
}

export async function copyDurableBackup(
  sourcePath: string,
  backupPath: string,
): Promise<string> {
  const source = await lstat(sourcePath);
  if (!source.isFile() || source.isSymbolicLink()) {
    throw new Error(
      `transaction backup 대상이 regular file이 아닙니다: ${sourcePath}`,
    );
  }
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(sourcePath, backupPath, constants.COPYFILE_EXCL);
  const handle = await open(backupPath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(backupPath));
  return sha256File(backupPath);
}

export async function restoreBackupAtomically(
  backupPath: string,
  targetPath: string,
): Promise<void> {
  const backup = await lstat(backupPath);
  if (!backup.isFile() || backup.isSymbolicLink()) {
    throw new Error(
      `transaction backup이 regular file이 아닙니다: ${backupPath}`,
    );
  }
  await mkdir(dirname(targetPath), { recursive: true });
  const restoreTemp = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.restore.tmp`,
  );
  try {
    await copyFile(backupPath, restoreTemp, constants.COPYFILE_EXCL);
    const handle = await open(restoreTemp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithTransientRetry(restoreTemp, targetPath);
    await syncDirectory(dirname(targetPath));
  } catch (error) {
    try {
      await unlink(restoreTemp);
    } catch (cleanupError) {
      if (!isErrnoCode(cleanupError, "ENOENT")) {
        throwCleanupFailure(
          error,
          cleanupError,
          `transaction restore와 temp cleanup이 모두 실패했습니다: ${targetPath}`,
        );
      }
    }
    throw error;
  }
}

export async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function pathState(
  path: string,
): Promise<"missing" | "file" | "directory" | "symlink" | "other"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      return "symlink";
    }
    if (stat.isFile()) {
      return "file";
    }
    if (stat.isDirectory()) {
      return "directory";
    }
    return "other";
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return "missing";
    }
    throw error;
  }
}

export async function assertDirectoryWithoutSymlink(
  path: string,
): Promise<void> {
  const state = await pathState(path);
  if (state !== "directory") {
    throw new Error(
      `transaction directory가 안전한 directory가 아닙니다: ${path}`,
    );
  }
}

export async function assertPathWithinRootWithoutSymlinks(
  rootPath: string,
  targetPath: string,
  options: { allowMissingTarget?: boolean } = {},
): Promise<void> {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const child = relative(root, target);
  if (child === "" || !child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("transaction path가 허용된 root 안에 있지 않습니다.");
  }
  if ((await pathState(root)) !== "directory") {
    throw new Error(`transaction root가 안전한 directory가 아닙니다: ${root}`);
  }

  const segments = child.split(/[\\/]/);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const state = await pathState(current);
    const isTarget = index === segments.length - 1;
    if (state === "missing") {
      if (isTarget && options.allowMissingTarget) {
        return;
      }
      if (!isTarget) {
        return;
      }
      throw new Error(`transaction path를 찾지 못했습니다: ${current}`);
    }
    if (state === "symlink") {
      throw new Error(`transaction path에 symlink가 있습니다: ${current}`);
    }
    if (!isTarget && state !== "directory") {
      throw new Error(
        `transaction path ancestor가 directory가 아닙니다: ${current}`,
      );
    }
  }
}

export async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (
      isErrnoException(error) &&
      typeof error.code === "string" &&
      UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code)
    ) {
      if (!warnedUnsupportedDirectorySyncCodes.has(error.code)) {
        warnedUnsupportedDirectorySyncCodes.add(error.code);
        logLibraryWarning(
          "Directory fsync is unsupported; continuing best-effort",
          {
            path,
            code: error.code,
          },
        );
      }
      return;
    }
    throw error;
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

export async function syncDirectoryTree(root: string): Promise<void> {
  const state = await pathState(root);
  if (state !== "directory") {
    throw new Error(`publish staging root가 directory가 아닙니다: ${root}`);
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `publish staging directory에 symlink가 있습니다: ${child}`,
      );
    }
    if (entry.isDirectory()) {
      await syncDirectoryTree(child);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `publish staging directory에 지원하지 않는 path가 있습니다: ${child}`,
      );
    }
    const handle = await open(child, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await syncDirectory(root);
}

export async function durableRename(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  await renameWithTransientRetry(sourcePath, targetPath);
  await syncDirectory(dirname(sourcePath));
  if (dirname(sourcePath) !== dirname(targetPath)) {
    await syncDirectory(dirname(targetPath));
  }
}

export async function durableRemoveFile(path: string): Promise<void> {
  await unlink(path);
  await syncDirectory(dirname(path));
}

export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: false });
  await syncDirectory(dirname(path));
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return isErrnoException(error) && error.code === code;
}
