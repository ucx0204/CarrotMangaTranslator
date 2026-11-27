import type {
  InpaintRunOptions,
  InpaintingWindowMask,
} from "./inpaintingEngine";
import { buildLocalMask } from "./imageRaster";
import { expandRect } from "./maskGeometry";

export type ExclusiveInpaintingWindowMasks = {
  core: InpaintingWindowMask;
  input: InpaintingWindowMask;
};

/** A partial selection inside a larger printed title must not condition the
 * model on the remaining half of the same letters. Transfer its ownership only
 * when the containing selection already covers every pixel it could write. */
export function containingTypographyOwners(
  options: InpaintRunOptions,
): number[] | undefined {
  const { windowMasks, compositeMasks, speechBubbleWindows } = options;
  if (!windowMasks || !compositeMasks || windowMasks.length < 2) return;
  return windowMasks.map((small, index) => {
    let owner = index;
    if (speechBubbleWindows?.[index]) return owner;
    for (const [other, large] of windowMasks.entries()) {
      const current = windowMasks[owner].bounds;
      if (large.bounds.w * large.bounds.h <= current.w * current.h) continue;
      if (!sharesWriteBoundary(options, index, other)) continue;
      if (
        containsActivePixels(large, small) &&
        containsActivePixels(compositeMasks[other], compositeMasks[index])
      )
        owner = other;
    }
    return owner;
  });
}
function sharesWriteBoundary(
  {
    speechBubbleWindows,
    compositeFeatherPx,
    compositeConstraints,
  }: InpaintRunOptions,
  index: number,
  other: number,
) {
  if (
    speechBubbleWindows?.[other] ||
    compositeFeatherPx?.[index] !== compositeFeatherPx?.[other]
  )
    return false;
  const outer = compositeConstraints?.[other],
    inner = compositeConstraints?.[index];
  return !outer || (!!inner && containsActivePixels(outer, inner));
}

function containsActivePixels(
  outer: InpaintingWindowMask,
  inner: InpaintingWindowMask,
) {
  const a = outer.bounds,
    b = inner.bounds;
  const dx = b.x - a.x,
    dy = b.y - a.y;
  if (dx < 0 || dy < 0 || dx + b.w > a.w || dy + b.h > a.h) return false;
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (inner.data[y * b.w + x] && !outer.data[(dy + y) * a.w + dx + x])
        return false;
    }
  }
  return true;
}

export function buildExclusivePaddedWindowMasks(
  windowMasks: InpaintingWindowMask[],
  pageWidth: number,
  pageHeight: number,
  paddingPx: number,
  priorityMasks: InpaintingWindowMask[] = windowMasks,
  containingOwners?: number[],
): ExclusiveInpaintingWindowMasks[] {
  if (windowMasks.length >= 0xffff) {
    throw new Error("Too many block-owned inpainting masks.");
  }
  if (priorityMasks.length !== windowMasks.length)
    throw new Error("Inpainting priority mask count does not match windows.");
  for (const windowMask of [...windowMasks, ...priorityMasks]) {
    validateWindowMask(windowMask, pageWidth, pageHeight);
  }
  const ownerIds = windowMasks.map((_, i) => (containingOwners?.[i] ?? i) + 1);
  const owners = new Uint16Array(pageWidth * pageHeight);
  // Reserve actual write cores before broad model-conditioning masks. A
  // previous context rectangle must not steal a later block's source glyphs.
  for (const [index, priorityMask] of priorityMasks.entries()) {
    assignUnownedPixels(owners, priorityMask, pageWidth, ownerIds[index]);
  }
  for (const [index, windowMask] of windowMasks.entries()) {
    assignUnownedPixels(owners, windowMask, pageWidth, ownerIds[index]);
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
    assignUnownedPixels(owners, windowMask, pageWidth, ownerIds[index]);
  }
  return windowMasks.map((windowMask, index) => ({
    core: keepOwnedPixels(windowMask, owners, pageWidth, index + 1),
    input: keepOwnedPixels(paddedMasks[index], owners, pageWidth, index + 1),
  }));
}

export function isWindowMaskFullyOwnedByEarlierWindow(
  original: InpaintingWindowMask | undefined,
  exclusive: ExclusiveInpaintingWindowMasks | undefined,
): boolean {
  return (
    !!original &&
    !!exclusive &&
    original.data.some((value) => value > 0) &&
    !exclusive.core.data.some((value) => value > 0)
  );
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

export function validateWindowMask(
  windowMask: InpaintingWindowMask,
  pageWidth: number,
  pageHeight: number,
): void {
  const { bounds, data } = windowMask;
  if (
    ![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isSafeInteger) ||
    !(data instanceof Uint8Array) ||
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
