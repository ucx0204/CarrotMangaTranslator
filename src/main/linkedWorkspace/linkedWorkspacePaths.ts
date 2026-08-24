import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import {
  isPathInside,
  renameWithTransientRetry,
  unlinkIfExists,
} from "../libraryStore/storage";
import type { RasterExportFormat } from "../../shared/linkedWorkspaceTypes";

const SUPPORTED_SOURCE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function normalizeLinkedRelativePath(value: string): string {
  if (isAbsolute(value) || /^[\\/]/.test(value)) {
    throw new Error("자동 저장 폴더의 상대 경로가 올바르지 않습니다.");
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..") ||
    isAbsolute(normalized)
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
  const sourceExtension = extname(source).toLowerCase();
  const captureFormat =
    format === "source"
      ? sourceExtension === ".jpg" || sourceExtension === ".jpeg"
        ? "jpeg"
        : sourceExtension === ".webp"
          ? "webp"
          : "png"
      : format;
  const extension =
    format === "source" && SUPPORTED_SOURCE_EXTENSIONS.has(sourceExtension)
      ? sourceExtension
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
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content);
    beforeCommit?.();
    await renameWithTransientRetry(temporaryPath, targetPath);
  } catch (error) {
    try {
      await unlinkIfExists(temporaryPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "자동 저장 폴더의 파일 저장과 임시 파일 정리에 모두 실패했습니다.",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export async function copyFileAtomically(
  sourcePath: string,
  targetPath: string,
  beforeCommit?: () => void,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await copyFile(sourcePath, temporaryPath);
    beforeCommit?.();
    await renameWithTransientRetry(temporaryPath, targetPath);
  } catch (error) {
    try {
      await unlinkIfExists(temporaryPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "자동 저장 폴더의 파일 복사와 임시 파일 정리에 모두 실패했습니다.",
        { cause: cleanupError },
      );
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
