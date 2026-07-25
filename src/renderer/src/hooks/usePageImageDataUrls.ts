import React from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import {
  clearPageImageRequestCache,
  createPageImageRequestCoordinator,
  getCachedPageImageDataUrl,
  preloadPageImage,
  type PageImageRequestCoordinator,
} from "./pageImageDataUrlCache";
import {
  createReadyPageImageFrame,
  EMPTY_PAGE_IMAGE_FRAME,
  markPageImageFramePending,
  resolveRenderablePageImages,
  type PageImageFrame,
} from "./pageImageFrame";

const EMPTY_NEIGHBOR_TARGETS: Array<{ pageId: string; imagePath: string }> = [];

type UsePageImageDataUrlsOptions = {
  chapterId: string | null;
  selectedPage: MangaPage | null;
  selectedPageImagePath: string | null;
  /** Adjacent pages to prefetch so flipping swaps from cache without a blank frame. */
  neighborTargets?: Array<{ pageId: string; imagePath: string }>;
};

type UsePageImageDataUrlsResult = {
  selectedPageImageDataUrl: string;
  selectedPageImageDataUrlPageId: string | null;
  selectedPageOriginalImageDataUrl: string;
  selectedPageOriginalImageDataUrlPageId: string | null;
  clearPageImageCache: () => void;
};

type PageImageFrameSetter = React.Dispatch<
  React.SetStateAction<PageImageFrame>
>;

type OriginalPageImageEffectOptions = {
  cacheRevision: number;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
  requestCoordinatorRef: React.MutableRefObject<PageImageRequestCoordinator>;
  selectedPageImage: PageImageFrame;
  selectedPageId: string | null;
  selectedPageImagePath: string | null;
  selectedPageOriginalImagePath: string | null;
  setSelectedPageOriginalImage: PageImageFrameSetter;
};

export function usePageImageDataUrls({
  chapterId,
  selectedPage,
  selectedPageImagePath,
  neighborTargets = EMPTY_NEIGHBOR_TARGETS,
}: UsePageImageDataUrlsOptions): UsePageImageDataUrlsResult {
  const [selectedPageImage, setSelectedPageImage] =
    React.useState<PageImageFrame>(EMPTY_PAGE_IMAGE_FRAME);
  const [selectedPageOriginalImage, setSelectedPageOriginalImage] =
    React.useState<PageImageFrame>(EMPTY_PAGE_IMAGE_FRAME);
  const [cacheRevision, setCacheRevision] = React.useState(0);
  const [pageImageCache] = React.useState(() => new Map<string, string>());
  const pageImageCacheRef = React.useRef<Map<string, string>>(pageImageCache);
  const [requestCoordinator] = React.useState(
    createPageImageRequestCoordinator,
  );
  const requestCoordinatorRef =
    React.useRef<PageImageRequestCoordinator>(requestCoordinator);
  const selectedPageId = selectedPage?.id ?? null;
  const selectedPageOriginalImagePath = selectedPage?.imagePath ?? null;
  const effectiveSelectedPageImagePath =
    selectedPageImagePath ?? selectedPageOriginalImagePath;

  const clearPageImageCache = useClearPageImageCache({
    chapterId,
    pageImageCacheRef,
    requestCoordinatorRef,
    setCacheRevision,
    setSelectedPageImage,
    setSelectedPageOriginalImage,
  });
  useSelectedPageImageEffect({
    cacheRevision,
    pageImageCacheRef,
    requestCoordinatorRef,
    selectedPageId,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageImage,
  });
  useOriginalPageImageEffect({
    cacheRevision,
    pageImageCacheRef,
    requestCoordinatorRef,
    selectedPageImage,
    selectedPageId,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageOriginalImage,
  });
  useNeighborPagePrefetch(
    neighborTargets,
    pageImageCacheRef,
    requestCoordinatorRef,
  );

  const { original, selected } = resolveRenderablePageImages({
    coordinator: requestCoordinator,
    currentOriginal: selectedPageOriginalImage,
    currentSelected: selectedPageImage,
    originalImagePath: selectedPageOriginalImagePath,
    pageId: selectedPageId,
    pageImageCache,
    selectedImagePath: effectiveSelectedPageImagePath,
  });

  return {
    selectedPageImageDataUrl: selected.dataUrl,
    selectedPageImageDataUrlPageId: selected.readyPageId,
    selectedPageOriginalImageDataUrl: original.dataUrl,
    selectedPageOriginalImageDataUrlPageId: original.readyPageId,
    clearPageImageCache,
  };
}

function useClearPageImageCache({
  chapterId,
  pageImageCacheRef,
  requestCoordinatorRef,
  setCacheRevision,
  setSelectedPageImage,
  setSelectedPageOriginalImage,
}: {
  chapterId: string | null;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
  requestCoordinatorRef: React.MutableRefObject<PageImageRequestCoordinator>;
  setCacheRevision: React.Dispatch<React.SetStateAction<number>>;
  setSelectedPageImage: PageImageFrameSetter;
  setSelectedPageOriginalImage: PageImageFrameSetter;
}): () => void {
  const clearPageImageCache = React.useCallback(() => {
    clearPageImageRequestCache(
      pageImageCacheRef.current,
      requestCoordinatorRef.current,
    );
    setCacheRevision((revision) => revision + 1);
  }, [pageImageCacheRef, requestCoordinatorRef, setCacheRevision]);

  React.useEffect(() => {
    setSelectedPageImage(EMPTY_PAGE_IMAGE_FRAME);
    setSelectedPageOriginalImage(EMPTY_PAGE_IMAGE_FRAME);
    clearPageImageCache();
  }, [
    chapterId,
    clearPageImageCache,
    setSelectedPageImage,
    setSelectedPageOriginalImage,
  ]);
  React.useEffect(
    () => () => {
      clearPageImageRequestCache(
        pageImageCacheRef.current,
        requestCoordinatorRef.current,
      );
    },
    [pageImageCacheRef, requestCoordinatorRef],
  );

  return clearPageImageCache;
}

function useSelectedPageImageEffect({
  cacheRevision,
  pageImageCacheRef,
  requestCoordinatorRef,
  selectedPageId,
  selectedPageImagePath,
  selectedPageOriginalImagePath,
  setSelectedPageImage,
}: {
  cacheRevision: number;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
  requestCoordinatorRef: React.MutableRefObject<PageImageRequestCoordinator>;
  selectedPageId: string | null;
  selectedPageImagePath: string | null;
  selectedPageOriginalImagePath: string | null;
  setSelectedPageImage: PageImageFrameSetter;
}): void {
  React.useEffect(() => {
    if (!selectedPageId || !selectedPageOriginalImagePath) {
      setSelectedPageImage(EMPTY_PAGE_IMAGE_FRAME);
      return;
    }

    const imagePath = selectedPageImagePath ?? selectedPageOriginalImagePath;
    setSelectedPageImage((current) =>
      markPageImageFramePending(current, selectedPageId),
    );
    const cacheKey = `${selectedPageId}:${imagePath}`;
    const coordinator = requestCoordinatorRef.current;
    const requestEpoch = coordinator.epoch;
    let cancelled = false;
    void loadDecodedPageImage(
      pageImageCacheRef.current,
      coordinator,
      cacheKey,
      imagePath,
    )
      .then((dataUrl) => {
        if (cancelled || coordinator.epoch !== requestEpoch) {
          return;
        }
        setSelectedPageImage(
          createReadyPageImageFrame(selectedPageId, dataUrl),
        );
      })
      .catch((error) => {
        if (!cancelled && coordinator.epoch === requestEpoch) {
          console.error(error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    cacheRevision,
    pageImageCacheRef,
    requestCoordinatorRef,
    selectedPageId,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageImage,
  ]);
}

function useOriginalPageImageEffect({
  cacheRevision,
  pageImageCacheRef,
  requestCoordinatorRef,
  selectedPageImage,
  selectedPageId,
  selectedPageImagePath,
  selectedPageOriginalImagePath,
  setSelectedPageOriginalImage,
}: OriginalPageImageEffectOptions): void {
  React.useEffect(() => {
    if (!selectedPageId || !selectedPageOriginalImagePath) {
      setSelectedPageOriginalImage(EMPTY_PAGE_IMAGE_FRAME);
      return;
    }
    if (
      selectedPageImagePath === selectedPageOriginalImagePath &&
      selectedPageImage.dataUrl &&
      selectedPageImage.readyPageId === selectedPageId
    ) {
      setSelectedPageOriginalImage(
        createReadyPageImageFrame(selectedPageId, selectedPageImage.dataUrl),
      );
      return;
    }

    setSelectedPageOriginalImage((current) =>
      markPageImageFramePending(current, selectedPageId),
    );
    const cacheKey = `${selectedPageId}:original:${selectedPageOriginalImagePath}`;
    const coordinator = requestCoordinatorRef.current;
    const requestEpoch = coordinator.epoch;
    let cancelled = false;
    void loadDecodedPageImage(
      pageImageCacheRef.current,
      coordinator,
      cacheKey,
      selectedPageOriginalImagePath,
    )
      .then((dataUrl) => {
        if (cancelled || coordinator.epoch !== requestEpoch) {
          return;
        }
        setSelectedPageOriginalImage(
          createReadyPageImageFrame(selectedPageId, dataUrl),
        );
      })
      .catch((error) => {
        if (!cancelled && coordinator.epoch === requestEpoch) {
          console.error(error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    cacheRevision,
    pageImageCacheRef,
    requestCoordinatorRef,
    selectedPageId,
    selectedPageImage,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageOriginalImage,
  ]);
}

async function loadDecodedPageImage(
  cache: Map<string, string>,
  coordinator: PageImageRequestCoordinator,
  cacheKey: string,
  imagePath: string,
): Promise<string> {
  const dataUrl = await getCachedPageImageDataUrl(
    cache,
    coordinator,
    cacheKey,
    imagePath,
  );
  await preloadPageImage(coordinator, dataUrl);
  return dataUrl;
}

function useNeighborPagePrefetch(
  neighborTargets: Array<{ pageId: string; imagePath: string }>,
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>,
  requestCoordinatorRef: React.MutableRefObject<PageImageRequestCoordinator>,
): void {
  React.useEffect(() => {
    if (neighborTargets.length === 0) {
      return;
    }
    for (const target of neighborTargets) {
      const cacheKey = `${target.pageId}:${target.imagePath}`;
      const coordinator = requestCoordinatorRef.current;
      const epoch = coordinator.epoch;
      void getCachedPageImageDataUrl(
        pageImageCacheRef.current,
        coordinator,
        cacheKey,
        target.imagePath,
      )
        .then((dataUrl) => {
          if (coordinator.epoch !== epoch) {
            return;
          }
          return preloadPageImage(coordinator, dataUrl);
        })
        .catch((error) => {
          if (coordinator.epoch === epoch) {
            console.warn("이웃 페이지 미리 불러오기 실패", error);
          }
        });
    }
  }, [neighborTargets, pageImageCacheRef, requestCoordinatorRef]);
}
