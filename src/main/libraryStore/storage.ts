import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";

const TRANSIENT_RENAME_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_MAX_ATTEMPTS = 12;
const RENAME_INITIAL_DELAY_MS = 25;
const RENAME_MAX_DELAY_MS = 1000;

export function isSupportedImagePath(filePath: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp"].includes(extname(filePath).toLowerCase());
}

export function isPathInside(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath);
  return child === "" || (!!child && !child.startsWith("..") && !isAbsolute(child));
}

export async function writeJsonFile(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await renameWithTransientRetry(tmpPath, path);
  } catch (error) {
    await safeUnlink(tmpPath);
    throw error;
  }
}

async function renameWithTransientRetry(sourcePath: string, destPath: string): Promise<void> {
  let delayMs = RENAME_INITIAL_DELAY_MS;
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(sourcePath, destPath);
      return;
    } catch (error) {
      if (attempt >= RENAME_MAX_ATTEMPTS || !isTransientRenameError(error)) {
        throw error;
      }
      await sleep(delayMs);
      delayMs = Math.min(RENAME_MAX_DELAY_MS, delayMs * 2);
    }
  }
}

function isTransientRenameError(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoException(error) && typeof error.code === "string" && TRANSIENT_RENAME_ERROR_CODES.has(error.code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readJsonFile<T>(path: string, fallback?: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (fallback !== undefined && isErrnoException(error) && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export function sortNaturally(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // no-op
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
