import { nativeImage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { MangaPage } from "../../shared/libraryTypes";
import type { PixelRect } from "./maskGeometry";
import type {
  InpaintingEngine,
  InpaintingWindowMask,
} from "./inpaintingEngine";
import { readApprovedImageSourceSnapshot } from "../imageRedactionContext";
import { loadPageImageSnapshot } from "./imageIO";

export type CodexNativePageContext = {
  sourcePage: MangaPage;
  cropRect: PixelRect;
};

/** Extend the INPUT with real neighboring page pixels. Output coordinates never change. */
export async function inpaintWithNativePageContext(
  context: CodexNativePageContext,
  run: (protection: Uint8Array) => InpaintingEngine,
  directory: string,
  protection: Uint8Array | undefined,
  args: Parameters<InpaintingEngine["inpaint"]>,
) {
  const [bitmap, width, height, mask, windows, options] = args;
  const { sourcePage: page, cropRect: crop } = context;
  validateContextBounds(context, width, height);
  const bytes =
    (await readApprovedImageSourceSnapshot(page.imagePath)) ??
    (await readFile(page.imagePath));
  const source = await loadPageImageSnapshot(
    page.imagePath,
    bytes,
    options?.decodeFallback,
    options?.signal,
  );
  const size = source.getSize();
  if (size.width !== page.width || size.height !== page.height)
    throw new Error("원본 페이지 문맥의 해상도가 달라졌습니다.");
  const full = Buffer.from(source.toBitmap());
  const fullMask = new Uint8Array(page.width * page.height);
  const keep = new Uint8Array(fullMask.length).fill(255);
  for (let y = 0; y < height; y++) {
    const from = y * width,
      to = (y + crop.y) * page.width + crop.x;
    bitmap.copy(full, to * 4, from * 4, (from + width) * 4);
    fullMask.set(mask.subarray(from, from + width), to);
    if (protection) keep.set(protection.subarray(from, from + width), to);
    else keep.fill(0, to, to + width);
  }
  const inputImagePath = join(directory, `native-context-${randomUUID()}.png`);
  await writeFile(
    inputImagePath,
    nativeImage.createFromBitmap(full, size).toPNG(),
    { signal: options?.signal },
  );
  await run(keep).inpaint(
    full,
    page.width,
    page.height,
    fullMask,
    windows.map((box) => shiftContextRect(box, crop)),
    contextRunOptions(options, page.imagePath, inputImagePath, crop),
  );
  options?.signal?.throwIfAborted();
  for (let y = 0; y < height; y++)
    full.copy(
      bitmap,
      y * width * 4,
      ((y + crop.y) * page.width + crop.x) * 4,
      ((y + crop.y) * page.width + crop.x + width) * 4,
    );
}

export async function verifyCodexInputBitmap(
  request: {
    bitmap: Buffer;
    width: number;
    height: number;
    signal: AbortSignal;
  },
  options: Parameters<InpaintingEngine["inpaint"]>[5],
): Promise<void> {
  const sourcePath = options?.sourceImagePath ?? "";
  const approved = await readApprovedImageSourceSnapshot(sourcePath);
  if (!approved) return;
  request.signal.throwIfAborted();
  const inputPath = options?.inputImagePath ?? sourcePath;
  const bytes =
    resolve(inputPath) === resolve(sourcePath)
      ? approved
      : await readFile(inputPath);
  const decoded = await loadPageImageSnapshot(
    inputPath,
    bytes,
    options?.decodeFallback,
    request.signal,
  );
  request.signal.throwIfAborted();
  const size = decoded.getSize();
  if (
    size.width !== request.width ||
    size.height !== request.height ||
    !decoded.toBitmap().equals(request.bitmap)
  )
    throw new Error(
      "확인한 이미지와 전송할 이미지가 다릅니다. 작업을 다시 시작해 주세요.",
    );
}

function validateContextBounds(
  context: CodexNativePageContext,
  width: number,
  height: number,
) {
  const { sourcePage: page, cropRect: crop } = context;
  if (
    crop.w !== width ||
    crop.h !== height ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.x + width > page.width ||
    crop.y + height > page.height
  )
    throw new Error("원본 페이지 문맥과 선택 영역의 좌표가 다릅니다.");
}

function shiftContextRect(box: PixelRect, crop: PixelRect): PixelRect {
  return { ...box, x: box.x + crop.x, y: box.y + crop.y };
}
function contextRunOptions(
  options: Parameters<InpaintingEngine["inpaint"]>[5],
  sourceImagePath: string,
  inputImagePath: string,
  crop: PixelRect,
) {
  const shiftMask = (value: InpaintingWindowMask) => ({
    ...value,
    bounds: shiftContextRect(value.bounds, crop),
  });
  return {
    ...options,
    sourceImagePath,
    inputImagePath,
    codexTargets: options?.codexTargets?.map((target) => ({
      ...target,
      bounds: shiftContextRect(target.bounds, crop),
    })),
    windowMasks: options?.windowMasks?.map(shiftMask),
    compositeMasks: options?.compositeMasks?.map(shiftMask),
    compositeConstraints: options?.compositeConstraints?.map((value) =>
      value ? shiftMask(value) : null,
    ),
  };
}
