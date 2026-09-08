import { normalizedRegionToPixelRect } from "../shared/region";
import type { MangaPage } from "../shared/libraryTypes";
import type { BBox } from "../shared/textTypes";
import { readImageRedactionState } from "./imageRedactionStore";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeImage } from "electron";
import type {
  ImageRedactionPage,
  ImageRedactionStroke,
} from "../shared/imageRedaction";
import type { PixelRect } from "../shared/region";
import { getAppPaths } from "./appPaths";
import { loadPageImageSnapshot } from "./inpainting/imageIO";
import { decodeImageThroughRuntime } from "./simplePageRuntime";
import {
  flattenImageRedaction,
  rasterizeImageRedaction,
} from "./imageRedactionPixels";

type Source = {
  width: number;
  height: number;
  mask?: Uint8Array;
  strokes?: ImageRedactionStroke[];
  fingerprint: string;
  copy?: Promise<string>;
  signal?: AbortSignal;
};
const contexts = new AsyncLocalStorage<Map<string, Source>>();
export async function imageFingerprint(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
export async function withApprovedImageRedactions<T>(
  pages: readonly ImageRedactionPage[],
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const context = new Map<string, Source>(
    pages.map((page) => [
      resolve(page.imagePath),
      {
        width: page.width,
        height: page.height,
        fingerprint: page.fingerprint,
        strokes: page.strokes,
        signal,
      },
    ]),
  );
  try {
    return await contexts.run(context, run);
  } finally {
    for (const source of context.values())
      if (source.copy) {
        await source.copy
          .then((path) => rm(path, { force: true }))
          .catch((error: unknown) =>
            console.error("Redacted image cleanup failed", error),
          );
      }
  }
}
function sourceMask(source: Source): Uint8Array {
  return (source.mask ??= rasterizeImageRedaction(
    source.width,
    source.height,
    source.strokes ?? [],
  ));
}
export async function registerImageRedactionCrop(
  path: string,
  parentPath: string,
  rect: PixelRect,
  size = { width: rect.w, height: rect.h },
): Promise<void> {
  const context = contexts.getStore();
  if (!context) return;
  const parent = requireSource(parentPath);
  const mask = new Uint8Array(size.width * size.height);
  const parentMask = sourceMask(parent);
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++) {
      const left = Math.max(
        0,
        rect.x + Math.floor((x * rect.w) / size.width) - 3,
      );
      const top = Math.max(
        0,
        rect.y + Math.floor((y * rect.h) / size.height) - 3,
      );
      const right = Math.min(
        parent.width,
        rect.x + Math.ceil(((x + 1) * rect.w) / size.width) + 3,
      );
      const bottom = Math.min(
        parent.height,
        rect.y + Math.ceil(((y + 1) * rect.h) / size.height) + 3,
      );
      if (
        maskIntersects(parentMask, parent.width, {
          x: left,
          y: top,
          w: right - left,
          h: bottom - top,
        })
      )
        mask[y * size.width + x] = 255;
    }
  context.set(resolve(path), {
    ...size,
    mask,
    fingerprint: await imageFingerprint(path),
    signal: parent.signal,
  });
}
function requireSource(path: string): Source {
  const source = contexts.getStore()?.get(resolve(path));
  if (!source)
    throw new Error(
      "전송 전에 확인하지 않은 이미지입니다. 작업을 다시 시작해 주세요.",
    );
  return source;
}
export function externalImageMask(
  path: string | undefined,
  width: number,
  height: number,
): Uint8Array | undefined {
  if (!contexts.getStore()) return undefined;
  const source = requireSource(path ?? "");
  if (source.width !== width || source.height !== height)
    throw new Error("가리기 영역의 이미지 크기가 변경되었습니다.");
  return sourceMask(source);
}
export async function readApprovedImageSourceSnapshot(
  path: string | undefined,
): Promise<Buffer | undefined> {
  if (!contexts.getStore()) return undefined;
  const source = requireSource(path ?? "");
  source.signal?.throwIfAborted();
  const bytes = await readFile(path ?? "");
  source.signal?.throwIfAborted();
  if (createHash("sha256").update(bytes).digest("hex") !== source.fingerprint)
    throw new Error("확인한 원본 이미지가 변경되었습니다.");
  return bytes;
}
export async function prepareExternalImageFile(
  path: string,
  root?: string,
): Promise<string> {
  await requireImageRedactionReview(root);
  const bytes = await readApprovedImageSourceSnapshot(path);
  if (!bytes) return path;
  const source = requireSource(path);
  return (source.copy ??= writeRedactedCopy(path, bytes, source, root));
}
async function writeRedactedCopy(
  path: string,
  bytes: Buffer,
  source: Source,
  root = getAppPaths().dataRoot,
): Promise<string> {
  const original = await loadPageImageSnapshot(
    path,
    bytes,
    (filePath) =>
      decodeImageThroughRuntime(
        getAppPaths().runtimeDir,
        filePath,
        source.signal,
      ),
    source.signal,
  );
  source.signal?.throwIfAborted();
  const size = original.getSize();
  if (size.width !== source.width || size.height !== source.height)
    throw new Error("가리기 이미지 크기가 변경되었습니다.");
  const image = nativeImage.createFromBitmap(
    flattenImageRedaction(original.toBitmap(), sourceMask(source)),
    size,
  );
  const directory = join(root, "external-image-copies");
  await mkdir(directory, { recursive: true });
  const output = join(directory, `${randomUUID()}.png`);
  await writeFile(output, image.toPNG());
  return output;
}

export async function requireImageRedactionReview(
  root?: string,
): Promise<void> {
  if (!contexts.getStore() && (await readImageRedactionState(root)).enabled)
    throw new Error("외부 이미지 전송 전에 가릴 페이지를 확인해 주세요.");
}
export function externalImageRegionIsHidden(
  page: Pick<MangaPage, "imagePath" | "width" | "height">,
  bbox: BBox,
): boolean {
  const mask = externalImageMask(page.imagePath, page.width, page.height);
  if (!mask) return false;
  const rect = normalizedRegionToPixelRect(bbox, page);
  return maskIntersects(mask, page.width, rect);
}
function maskIntersects(
  mask: Uint8Array,
  width: number,
  rect: PixelRect,
): boolean {
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++)
      if (mask[y * width + x]) return true;
  return false;
}
