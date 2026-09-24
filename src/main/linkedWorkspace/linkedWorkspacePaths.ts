import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import {
  isPathInside,
  renameWithTransientRetry,
  unlinkIfExists,
  type AtomicFilePublication,
} from "../libraryStore/storage";
import type {
  LinkedWorkspaceRecordV1,
  RasterExportFormat,
} from "../../shared/linkedWorkspaceTypes";
import { resolveSourceImageFormat } from "../../shared/sourceImageFormat";

export function normalizeLinkedRelativePath(value: string): string {
  if (
    isAbsolute(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[\\/]/.test(value)
  ) {
    throw new Error("자동 저장 폴더의 상대 경로가 올바르지 않습니다.");
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..") ||
    isAbsolute(normalized) ||
    posix.isAbsolute(normalized) ||
    win32.isAbsolute(normalized)
  ) {
    throw new Error("자동 저장 폴더의 상대 경로가 올바르지 않습니다.");
  }
  return segments.join("/");
}

export function resolvePathInside(
  rootPath: string,
  relativePath: string,
): string {
  const root = resolve(rootPath);
  const target = resolve(root, normalizeLinkedRelativePath(relativePath));
  if (!isPathInside(root, target) || target === root) {
    throw new Error("자동 저장 폴더 밖의 경로는 사용할 수 없습니다.");
  }
  return target;
}

export function resolveLinkedResultPath({
  rootPath,
  sourceRelativePath,
  format,
}: {
  rootPath: string;
  sourceRelativePath: string;
  format: RasterExportFormat;
}): { path: string; captureFormat: "png" | "jpeg" | "webp" } {
  const source = normalizeLinkedRelativePath(sourceRelativePath);
  const sourceExtension = extname(source);
  const sourceFormat = resolveSourceImageFormat(sourceExtension);
  const captureFormat = format === "source" ? sourceFormat.format : format;
  const extension =
    format === "source"
      ? `.${sourceFormat.extension}`
      : captureFormat === "jpeg"
        ? ".jpg"
        : `.${captureFormat}`;
  const withoutExtension = source.slice(
    0,
    source.length - sourceExtension.length,
  );
  return {
    path: resolvePathInside(rootPath, `result/${withoutExtension}${extension}`),
    captureFormat,
  };
}

export function resolveLinkedPngArtifactPath({
  rootPath,
  directory,
  sourceRelativePath,
  disambiguateExtension,
}: {
  rootPath: string;
  directory: "inpainted" | "mask";
  sourceRelativePath: string;
  disambiguateExtension: boolean;
}): string {
  const source = normalizeLinkedRelativePath(sourceRelativePath);
  const extension = extname(source);
  const stem = source.slice(0, source.length - extension.length);
  const outputName = disambiguateExtension
    ? `${stem}${extension.toLowerCase()}.png`
    : `${stem}.png`;
  return resolvePathInside(rootPath, `${directory}/${outputName}`);
}

export function buildLinkedMirrorFileName(rootPath: string): string {
  const safe =
    basename(resolve(rootPath))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 80) || "workspace";
  return `manga-translator-${safe}.json`;
}

export async function writeBinaryFileAtomically(
  targetPath: string,
  content: Buffer,
  beforeCommit?: () => void,
  publication?: AtomicFilePublication,
): Promise<void> {
  await publishLinkedFileAtomically(
    targetPath,
    (temporaryPath) => writeFile(temporaryPath, content),
    "자동 저장 폴더의 파일 저장과 임시 파일 정리에 모두 실패했습니다.",
    beforeCommit,
    publication,
  );
}

export async function copyFileAtomically(
  sourcePath: string,
  targetPath: string,
  beforeCommit?: () => void,
  publication?: AtomicFilePublication,
): Promise<void> {
  await publishLinkedFileAtomically(
    targetPath,
    (temporaryPath) => copyFile(sourcePath, temporaryPath),
    "자동 저장 폴더의 파일 복사와 임시 파일 정리에 모두 실패했습니다.",
    beforeCommit,
    publication,
  );
}

async function publishLinkedFileAtomically(
  targetPath: string,
  prepareTemporary: (temporaryPath: string) => Promise<void>,
  cleanupFailureMessage: string,
  beforeCommit?: () => void,
  publication?: AtomicFilePublication,
): Promise<void> {
  const hooks = publication ?? {};
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  hooks.signal?.throwIfAborted();
  await hooks.beforePrepare?.(temporaryPath, targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await hooks.beforePrepare?.(temporaryPath, targetPath);
    hooks.signal?.throwIfAborted();
    await prepareTemporary(temporaryPath);
    await hooks.prepared?.(temporaryPath, targetPath);
    beforeCommit?.();
    await renameWithTransientRetry(
      temporaryPath,
      targetPath,
      hooks.signal,
      hooks.beforeAttempt,
    );
    await hooks.committed?.();
  } catch (error) {
    try {
      await unlinkIfExists(temporaryPath);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], cleanupFailureMessage, {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

export function relativePathFromRoot(
  rootPath: string,
  filePath: string,
): string {
  const candidate = relative(resolve(rootPath), resolve(filePath));
  if (!candidate || candidate.startsWith("..") || isAbsolute(candidate)) {
    throw new Error("복구용 원본 이미지가 자동 저장 폴더 안에 있지 않습니다.");
  }
  return normalizeLinkedRelativePath(candidate);
}

export async function cleanupLinkedWorkspaceTemporaryFiles(
  rootPath: string,
): Promise<void> {
  await removeTemporaryFiles(resolve(rootPath), false);
  for (const directory of ["result", "inpainted", "mask"] as const) {
    await removeTemporaryFiles(
      resolvePathInside(rootPath, `${directory}/.probe`).replace(
        /[\\/]\.probe$/,
        "",
      ),
      true,
    );
  }
}

async function removeTemporaryFiles(
  directoryPath: string,
  recursive: boolean,
): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    if (recursive && entry.isDirectory()) {
      await removeTemporaryFiles(entryPath, true);
    } else if (entry.isFile() && isManagedTemporaryName(entry.name)) {
      await unlinkIfExists(entryPath);
    }
  }
}

function isManagedTemporaryName(fileName: string): boolean {
  return /^\..+\.\d+\.[0-9a-f]{8}-[0-9a-f-]{27}\.tmp$/i.test(fileName);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function hasStemCollision(
  record: LinkedWorkspaceRecordV1,
  pageId: string,
  sourceRelativePath: string,
): boolean {
  const normalized =
    normalizeLinkedRelativePath(sourceRelativePath).toLowerCase();
  const stem = normalized.slice(
    0,
    normalized.length - extname(normalized).length,
  );
  return Object.entries(record.pageRelativePaths).some(
    ([candidateId, path]) => {
      if (candidateId === pageId) return false;
      const candidate = normalizeLinkedRelativePath(path).toLowerCase();
      return (
        candidate.slice(0, candidate.length - extname(candidate).length) ===
        stem
      );
    },
  );
}
