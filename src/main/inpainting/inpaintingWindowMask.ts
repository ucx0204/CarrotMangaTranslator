import type { InpaintingWindowMask } from "./inpaintingEngine";
import { buildLocalMask } from "./imageRaster";
import { expandRect } from "./maskGeometry";

export type ExclusiveInpaintingWindowMasks = {
  core: InpaintingWindowMask;
  input: InpaintingWindowMask;
};

export function buildExclusivePaddedWindowMasks(
  windowMasks: InpaintingWindowMask[],
  pageWidth: number,
  pageHeight: number,
  paddingPx: number,
): ExclusiveInpaintingWindowMasks[] {
  if (windowMasks.length >= 0xffff) {
    throw new Error("Too many block-owned inpainting masks.");
  }
  for (const windowMask of windowMasks) {
    validateWindowMask(windowMask, pageWidth, pageHeight);
  }
  const owners = new Uint16Array(pageWidth * pageHeight);
  for (const [index, windowMask] of windowMasks.entries()) {
    assignUnownedPixels(owners, windowMask, pageWidth, index + 1);
  }
  const paddedMasks = windowMasks.map((windowMask) =>
    padWindowMask(
      windowMask,
      pageWidth,
      pageHeight,
      Math.max(0, Math.round(paddingPx)),
    ),
  );
  for (const [index, windowMask] of paddedMasks.entries()) {
    assignUnownedPixels(owners, windowMask, pageWidth, index + 1);
  }
  return windowMasks.map((windowMask, index) => ({
    core: keepOwnedPixels(windowMask, owners, pageWidth, index + 1),
    input: keepOwnedPixels(paddedMasks[index], owners, pageWidth, index + 1),
  }));
}

export function expandWindowMaskToPage(
  windowMask: InpaintingWindowMask,
  pageWidth: number,
  pageHeight: number,
): Uint8Array {
  validateWindowMask(windowMask, pageWidth, pageHeight);
  const { bounds, data } = windowMask;
  const pageMask = new Uint8Array(pageWidth * pageHeight);
  for (let y = 0; y < bounds.h; y += 1) {
    const sourceStart = y * bounds.w;
    const targetStart = (bounds.y + y) * pageWidth + bounds.x;
    pageMask.set(
      data.subarray(sourceStart, sourceStart + bounds.w),
      targetStart,
    );
  }
  return pageMask;
}

function padWindowMask(
  windowMask: InpaintingWindowMask,
  pageWidth: number,
  pageHeight: number,
  paddingPx: number,
): InpaintingWindowMask {
  if (paddingPx === 0) {
    return { bounds: { ...windowMask.bounds }, data: windowMask.data.slice() };
  }
  const bounds = expandRect(
    windowMask.bounds,
    pageWidth,
    pageHeight,
    paddingPx,
  );
  const source = new Uint8Array(bounds.w * bounds.h);
  const offsetX = windowMask.bounds.x - bounds.x;
  const offsetY = windowMask.bounds.y - bounds.y;
  for (let y = 0; y < windowMask.bounds.h; y += 1) {
    const sourceStart = y * windowMask.bounds.w;
    const targetStart = (offsetY + y) * bounds.w + offsetX;
    source.set(
      windowMask.data.subarray(sourceStart, sourceStart + windowMask.bounds.w),
      targetStart,
    );
  }
  return {
    bounds,
    data: buildLocalMask(
      source,
      bounds.w,
      { x: 0, y: 0, w: bounds.w, h: bounds.h },
      paddingPx,
    ),
  };
}

function assignUnownedPixels(
  owners: Uint16Array,
  windowMask: InpaintingWindowMask,
  pageWidth: number,
  owner: number,
): void {
  forEachActiveWindowPixel(windowMask, pageWidth, (pageIndex) => {
    if (owners[pageIndex] === 0) owners[pageIndex] = owner;
  });
}

function keepOwnedPixels(
  windowMask: InpaintingWindowMask,
  owners: Uint16Array,
  pageWidth: number,
  owner: number,
): InpaintingWindowMask {
  const data = new Uint8Array(windowMask.data.length);
  forEachActiveWindowPixel(windowMask, pageWidth, (pageIndex, localIndex) => {
    if (owners[pageIndex] === owner) data[localIndex] = 1;
  });
  return { bounds: { ...windowMask.bounds }, data };
}

function forEachActiveWindowPixel(
  windowMask: InpaintingWindowMask,
  pageWidth: number,
  visit: (pageIndex: number, localIndex: number) => void,
): void {
  const { bounds, data } = windowMask;
  for (let y = 0; y < bounds.h; y += 1) {
    for (let x = 0; x < bounds.w; x += 1) {
      const localIndex = y * bounds.w + x;
      if (!data[localIndex]) continue;
      visit((bounds.y + y) * pageWidth + bounds.x + x, localIndex);
    }
  }
}

function validateWindowMask(
  windowMask: InpaintingWindowMask,
  pageWidth: number,
  pageHeight: number,
): void {
  const { bounds, data } = windowMask;
  if (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.w <= 0 ||
    bounds.h <= 0 ||
    bounds.x + bounds.w > pageWidth ||
    bounds.y + bounds.h > pageHeight ||
    data.length !== bounds.w * bounds.h
  ) {
    throw new Error("Invalid block-owned inpainting mask bounds.");
  }
}
