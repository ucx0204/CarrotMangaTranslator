import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ImageDecodeFallback } from "./inpaintingTypes";

const INPAINTED_ARTIFACT_SUFFIX_MAX_LENGTH = 16;

export async function loadPageImage(
  filePath: string,
  decodeFallback?: ImageDecodeFallback,
): Promise<Electron.NativeImage> {
  const direct = nativeImage.createFromPath(filePath);
  if (!direct.isEmpty()) {
    return direct;
  }

  const bytes = nativeImage.createFromBuffer(await readFile(filePath));
  if (!bytes.isEmpty()) return bytes;

  const fallbackBuffer = decodeFallback ? await decodeFallback(filePath) : null;
  if (fallbackBuffer?.length) {
    const fallback = nativeImage.createFromBuffer(fallbackBuffer);
    if (!fallback.isEmpty()) {
      return fallback;
    }
  }

  throw new Error("인페인팅할 이미지를 읽지 못했습니다.");
}

export async function loadPageImageSnapshot(
  filePath: string,
  bytes: Buffer,
  decodeFallback?: ImageDecodeFallback,
  signal?: AbortSignal,
): Promise<Electron.NativeImage> {
  signal?.throwIfAborted();
  const direct = nativeImage.createFromBuffer(bytes);
  if (!direct.isEmpty()) return direct;

  const directory = await mkdtemp(join(tmpdir(), "mgt-inpaint-snapshot-"));
  const snapshotPath = join(directory, `source${extname(filePath)}`);
  try {
    await writeFile(snapshotPath, bytes, { flag: "wx", signal });
    signal?.throwIfAborted();
    const decoded = await loadPageImage(snapshotPath, decodeFallback);
    signal?.throwIfAborted();
    return decoded;
  } finally {
    await rm(snapshotPath, { force: true });
    await rmdir(directory);
  }
}

export function resolveInpaintedImagePath(
  imagePath: string,
  suffix = "pattern",
): string {
  const imageDir = dirname(imagePath);
  const chapterDir = dirname(imageDir);
  const safeSuffix =
    suffix
      .replace(/[^a-z0-9_-]/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, INPAINTED_ARTIFACT_SUFFIX_MAX_LENGTH) || "image";
  return join(chapterDir, "inpainted", `${safeSuffix}-${randomUUID()}.png`);
}

export function resolveInpaintMaskPath(
  imagePath: string,
  suffix = "mask",
): string {
  const imageDir = dirname(imagePath);
  const chapterDir = dirname(imageDir);
  const safeSuffix =
    suffix
      .replace(/[^a-z0-9_-]/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, INPAINTED_ARTIFACT_SUFFIX_MAX_LENGTH) || "mask";
  return join(chapterDir, "mask", `${safeSuffix}-${randomUUID()}.png`);
}
