import type { PageImageRequestCoordinator } from "./pageImageDataUrlCache";

export type PageImageFrame = {
  dataUrl: string;
  readyPageId: string | null;
  renderedPageId: string | null;
  requestPageId: string | null;
  requestStatus: "idle" | "loading" | "error";
};

export const EMPTY_PAGE_IMAGE_FRAME: PageImageFrame = {
  dataUrl: "",
  readyPageId: null,
  renderedPageId: null,
  requestPageId: null,
  requestStatus: "idle",
};

export function markPageImageFramePending(
  current: PageImageFrame,
  selectedPageId: string,
): PageImageFrame {
  if (
    current.readyPageId === null &&
    current.requestPageId === selectedPageId &&
    current.requestStatus === "loading"
  ) {
    return current;
  }
  return {
    ...current,
    readyPageId: null,
    requestPageId: selectedPageId,
    requestStatus: "loading",
  };
}

export function markPageImageFrameFailed(
  current: PageImageFrame,
  selectedPageId: string,
): PageImageFrame {
  return {
    ...current,
    readyPageId: null,
    requestPageId: selectedPageId,
    requestStatus: "error",
  };
}

export function createReadyPageImageFrame(
  pageId: string,
  dataUrl: string,
): PageImageFrame {
  return {
    dataUrl,
    readyPageId: pageId,
    renderedPageId: pageId,
    requestPageId: null,
    requestStatus: "idle",
  };
}

export function isPageImageFrameLoading(
  frame: PageImageFrame,
  selectedPageId: string | null,
): boolean {
  return Boolean(
    selectedPageId &&
    frame.requestPageId === selectedPageId &&
    frame.requestStatus === "loading",
  );
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
  if (!pageId || !cacheKey) {
    return EMPTY_PAGE_IMAGE_FRAME;
  }
  if (current.renderedPageId === pageId) {
    return current.requestPageId && current.requestPageId !== pageId
      ? createReadyPageImageFrame(pageId, current.dataUrl)
      : current;
  }
  const cachedDataUrl = pageImageCache.get(cacheKey);
  if (cachedDataUrl && coordinator.preloadedByUrl.has(cachedDataUrl)) {
    return createReadyPageImageFrame(pageId, cachedDataUrl);
  }
  if (current.requestPageId === pageId && current.requestStatus === "error") {
    return current;
  }
  return markPageImageFramePending(current, pageId);
}
