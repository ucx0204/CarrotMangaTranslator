import type { PageImageRequestCoordinator } from "./pageImageDataUrlCache";

export type PageImageFrame = {
  dataUrl: string;
  readyPageId: string | null;
  renderedPageId: string | null;
};

export const EMPTY_PAGE_IMAGE_FRAME: PageImageFrame = {
  dataUrl: "",
  readyPageId: null,
  renderedPageId: null,
};

export function markPageImageFramePending(
  current: PageImageFrame,
  selectedPageId: string,
): PageImageFrame {
  if (current.renderedPageId !== selectedPageId) {
    return EMPTY_PAGE_IMAGE_FRAME;
  }
  if (current.readyPageId === null) {
    return current;
  }
  return { ...current, readyPageId: null };
}

export function createReadyPageImageFrame(
  pageId: string,
  dataUrl: string,
): PageImageFrame {
  return {
    dataUrl,
    readyPageId: pageId,
    renderedPageId: pageId,
  };
}

export function resolveRenderablePageImages({
  coordinator,
  currentOriginal,
  currentSelected,
  originalImagePath,
  pageId,
  pageImageCache,
  selectedImagePath,
}: {
  coordinator: PageImageRequestCoordinator;
  currentOriginal: PageImageFrame;
  currentSelected: PageImageFrame;
  originalImagePath: string | null;
  pageId: string | null;
  pageImageCache: Map<string, string>;
  selectedImagePath: string | null;
}): { original: PageImageFrame; selected: PageImageFrame } {
  const selected = resolveRenderablePageImageFrame({
    cacheKey:
      pageId && selectedImagePath ? `${pageId}:${selectedImagePath}` : null,
    coordinator,
    current: currentSelected,
    pageId,
    pageImageCache,
  });
  const original =
    selectedImagePath === originalImagePath && selected.dataUrl
      ? selected
      : resolveRenderablePageImageFrame({
          cacheKey:
            pageId && originalImagePath
              ? `${pageId}:original:${originalImagePath}`
              : null,
          coordinator,
          current: currentOriginal,
          pageId,
          pageImageCache,
        });
  return { original, selected };
}

function resolveRenderablePageImageFrame({
  cacheKey,
  coordinator,
  current,
  pageId,
  pageImageCache,
}: {
  cacheKey: string | null;
  coordinator: PageImageRequestCoordinator;
  current: PageImageFrame;
  pageId: string | null;
  pageImageCache: Map<string, string>;
}): PageImageFrame {
  if (current.renderedPageId === pageId) {
    return current;
  }
  if (!pageId || !cacheKey) {
    return EMPTY_PAGE_IMAGE_FRAME;
  }
  const cachedDataUrl = pageImageCache.get(cacheKey);
  return cachedDataUrl && coordinator.preloadedByUrl.has(cachedDataUrl)
    ? createReadyPageImageFrame(pageId, cachedDataUrl)
    : EMPTY_PAGE_IMAGE_FRAME;
}
