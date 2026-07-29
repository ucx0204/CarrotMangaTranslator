import { nativeImage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { clamp } from "../../shared/geometry";
import type { PixelRect } from "./maskGeometry";

export function cropBitmapFromPage(
  bitmap: Buffer,
  pageWidth: number,
  rect: PixelRect,
): Buffer {
  const output = Buffer.alloc(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y += 1) {
    const sourceStart = ((rect.y + y) * pageWidth + rect.x) * 4;
    const sourceEnd = sourceStart + rect.w * 4;
    bitmap.copy(output, y * rect.w * 4, sourceStart, sourceEnd);
  }
  return output;
}

export async function writePngFromBitmap(
  filePath: string,
  bitmap: Buffer,
  width: number,
  height: number,
  processSize: { width: number; height: number },
): Promise<void> {
  let image = nativeImage.createFromBitmap(bitmap, { width, height });
  if (processSize.width !== width || processSize.height !== height) {
    image = image.resize({
      width: processSize.width,
      height: processSize.height,
      quality: "best",
    });
  }
  if (image.isEmpty()) {
    throw new Error("Flux 입력 crop 이미지를 만들지 못했습니다.");
  }
  await writeFile(filePath, image.toPNG());
}

export async function writePngFromMask(
  filePath: string,
  mask: Uint8Array,
  width: number,
  height: number,
  processSize: { width: number; height: number },
): Promise<void> {
  const bitmap = Buffer.alloc(processSize.width * processSize.height * 4);
  for (let y = 0; y < processSize.height; y += 1) {
    const sourceY = clamp(
      Math.floor(((y + 0.5) * height) / processSize.height),
      0,
      height - 1,
    );
    for (let x = 0; x < processSize.width; x += 1) {
      const sourceX = clamp(
        Math.floor(((x + 0.5) * width) / processSize.width),
        0,
        width - 1,
      );
      const value = mask[sourceY * width + sourceX] ? 255 : 0;
      const offset = (y * processSize.width + x) * 4;
      bitmap[offset] = value;
      bitmap[offset + 1] = value;
      bitmap[offset + 2] = value;
      bitmap[offset + 3] = 255;
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, {
    width: processSize.width,
    height: processSize.height,
  });
  if (image.isEmpty()) {
    throw new Error("Flux 마스크 이미지를 만들지 못했습니다.");
  }
  await writeFile(filePath, image.toPNG());
}

export async function readGeneratedBitmap(
  filePath: string,
  targetWidth: number,
  targetHeight: number,
): Promise<Buffer> {
  const buffer = await readFile(filePath);
  let image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(filePath);
  }
  if (image.isEmpty()) {
    throw new Error("Flux 결과 이미지를 읽지 못했습니다.");
  }
  const size = image.getSize();
  if (size.width !== targetWidth || size.height !== targetHeight) {
    image = image.resize({
      width: targetWidth,
      height: targetHeight,
      quality: "best",
    });
  }
  return Buffer.from(image.toBitmap());
}

export function compositeFluxOutput(
  bitmap: Buffer,
  generated: Buffer,
  pageMask: Uint8Array,
  pageWidth: number,
  rect: PixelRect,
  featherPx: number,
  writeBounds: PixelRect = rect,
  compositeConstraint?: Uint8Array,
): void {
  const startX = clamp(writeBounds.x - rect.x, 0, rect.w);
  const startY = clamp(writeBounds.y - rect.y, 0, rect.h);
  const endX = clamp(writeBounds.x + writeBounds.w - rect.x, startX, rect.w);
  const endY = clamp(writeBounds.y + writeBounds.h - rect.y, startY, rect.h);
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const pageX = rect.x + x;
      const pageY = rect.y + y;
      if (
        !allowsCompositePixel(compositeConstraint, pageY * pageWidth + pageX)
      ) {
        continue;
      }
      const alpha = maskSoftAlphaAt(
        pageMask,
        pageWidth,
        pageX,
        pageY,
        featherPx,
      );
      if (alpha <= 0) {
        continue;
      }
      const targetOffset = (pageY * pageWidth + pageX) * 4;
      const sourceOffset = (y * rect.w + x) * 4;
      bitmap[targetOffset] = blendByte(
        bitmap[targetOffset] ?? 0,
        generated[sourceOffset] ?? 0,
        alpha,
      );
      bitmap[targetOffset + 1] = blendByte(
        bitmap[targetOffset + 1] ?? 0,
        generated[sourceOffset + 1] ?? 0,
        alpha,
      );
      bitmap[targetOffset + 2] = blendByte(
        bitmap[targetOffset + 2] ?? 0,
        generated[sourceOffset + 2] ?? 0,
        alpha,
      );
      bitmap[targetOffset + 3] = 255;
    }
  }
}

function allowsCompositePixel(
  constraint: Uint8Array | undefined,
  index: number,
): boolean {
  return !constraint || Boolean(constraint[index]);
}

export function maskBoundsInRect(
  mask: Uint8Array,
  pageWidth: number,
  rect: PixelRect,
): PixelRect | null {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = -1;
  let y2 = -1;
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (!mask[y * pageWidth + x]) {
        continue;
      }
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x + 1);
      y2 = Math.max(y2, y + 1);
    }
  }
  if (!Number.isFinite(x1) || x2 <= x1 || y2 <= y1) {
    return null;
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function buildLocalMask(
  pageMask: Uint8Array,
  pageWidth: number,
  rect: PixelRect,
  paddingPx: number,
): Uint8Array {
  const output = new Uint8Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      if (pageMask[(rect.y + y) * pageWidth + rect.x + x]) {
        output[y * rect.w + x] = 1;
      }
    }
  }
  return paddingPx > 0
    ? dilateMaskSquare(output, rect.w, rect.h, paddingPx)
    : output;
}

export function isolateMaskToWindow(
  mask: Uint8Array,
  pageWidth: number,
  window: PixelRect,
): Uint8Array {
  const isolated = new Uint8Array(mask.length);
  for (let y = window.y; y < window.y + window.h; y += 1) {
    const start = y * pageWidth + window.x;
    isolated.set(mask.subarray(start, start + window.w), start);
  }
  return isolated;
}

function blendByte(base: number, next: number, alpha: number): number {
  return clamp(Math.round(base * (1 - alpha) + next * alpha), 0, 255);
}

function maskSoftAlphaAt(
  mask: Uint8Array,
  width: number,
  x: number,
  y: number,
  featherPx: number,
): number {
  if (mask[y * width + x]) {
    return 1;
  }
  if (featherPx <= 0) {
    return 0;
  }
  const bestDistanceSq = findNearestMaskDistanceSq(
    mask,
    width,
    x,
    y,
    Math.max(1, featherPx),
  );
  if (!Number.isFinite(bestDistanceSq)) {
    return 0;
  }
  return clamp(1 - Math.sqrt(bestDistanceSq) / Math.max(1, featherPx), 0, 1);
}

function findNearestMaskDistanceSq(
  mask: Uint8Array,
  width: number,
  x: number,
  y: number,
  radius: number,
): number {
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const distanceSq = dx * dx + dy * dy;
      if (
        shouldUseMaskDistance(mask, width, x + dx, y + dy, distanceSq, {
          bestDistanceSq,
          radius,
        })
      ) {
        bestDistanceSq = distanceSq;
      }
    }
  }
  return bestDistanceSq;
}

function shouldUseMaskDistance(
  mask: Uint8Array,
  width: number,
  x: number,
  y: number,
  distanceSq: number,
  limits: { bestDistanceSq: number; radius: number },
): boolean {
  return (
    distanceSq <= limits.radius * limits.radius &&
    distanceSq < limits.bestDistanceSq &&
    maskHasValueAt(mask, width, x, y)
  );
}

function maskHasValueAt(
  mask: Uint8Array,
  width: number,
  x: number,
  y: number,
): boolean {
  const index = y * width + x;
  return (
    x >= 0 &&
    y >= 0 &&
    index >= 0 &&
    index < mask.length &&
    Boolean(mask[index])
  );
}

function dilateMaskSquare(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) {
    return mask;
  }
  return dilateMaskVertically(
    dilateMaskHorizontally(mask, width, height, radius),
    width,
    height,
    radius,
  );
}

function dilateMaskHorizontally(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    let count = countHorizontalMaskWindow(mask, width, height, y, radius);
    for (let x = 0; x < width; x += 1) {
      if (count > 0) {
        output[y * width + x] = 1;
      }
      count +=
        readMaskValue(mask, width, height, x + radius + 1, y) -
        readMaskValue(mask, width, height, x - radius, y);
    }
  }
  return output;
}

function dilateMaskVertically(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    let count = countVerticalMaskWindow(mask, width, height, x, radius);
    for (let y = 0; y < height; y += 1) {
      if (count > 0) {
        output[y * width + x] = 1;
      }
      count +=
        readMaskValue(mask, width, height, x, y + radius + 1) -
        readMaskValue(mask, width, height, x, y - radius);
    }
  }
  return output;
}

function countHorizontalMaskWindow(
  mask: Uint8Array,
  width: number,
  height: number,
  y: number,
  radius: number,
): number {
  let count = 0;
  for (let x = -radius; x <= radius; x += 1) {
    count += readMaskValue(mask, width, height, x, y);
  }
  return count;
}

function countVerticalMaskWindow(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  radius: number,
): number {
  let count = 0;
  for (let y = -radius; y <= radius; y += 1) {
    count += readMaskValue(mask, width, height, x, y);
  }
  return count;
}

function readMaskValue(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return 0;
  }
  return mask[y * width + x] ? 1 : 0;
}
