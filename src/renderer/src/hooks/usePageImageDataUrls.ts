import React from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import {
  clearPageImageRequestCache,
  createPageImageRequestCoordinator,
  getCachedPageImageDataUrl,
  preloadPageImage,
  type PageImageRequestCoordinator,
} from "./pageImageDataUrlCache";

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

type ImageDataUrlSetter = React.Dispatch<React.SetStateAction<string>>;
type PageImagePageIdSetter = React.Dispatch<
  React.SetStateAction<string | null>
>;
type OriginalPageImageEffectOptions = {
  cacheRevision: number;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
  requestCoordinatorRef: React.MutableRefObject<PageImageRequestCoordinator>;
  selectedPageId: string | null;
  selectedPageImageDataUrl: string;
  selectedPageImageDataUrlPageId: string | null;
  selectedPageImagePath: string | null;
  selectedPageOriginalImagePath: string | null;
  setSelectedPageOriginalImageDataUrl: ImageDataUrlSetter;
  setSelectedPageOriginalImageDataUrlPageId: PageImagePageIdSetter;
};

export function usePageImageDataUrls({
  chapterId,
  selectedPage,
  selectedPageImagePath,
  neighborTargets = EMPTY_NEIGHBOR_TARGETS,
}: UsePageImageDataUrlsOptions): UsePageImageDataUrlsResult {
  const [selectedPageImageDataUrl, setSelectedPageImageDataUrl] =
    React.useState("");
  const [
    selectedPageOriginalImageDataUrl,
    setSelectedPageOriginalImageDataUrl,
  ] = React.useState("");
  const [selectedPageImageDataUrlPageId, setSelectedPageImageDataUrlPageId] =
    React.useState<string | null>(null);
  const [
    selectedPageOriginalImageDataUrlPageId,
    setSelectedPageOriginalImageDataUrlPageId,
  ] = React.useState<string | null>(null);
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

  const clearPageImageCache = useClearPageImageCache({
    chapterId,
    pageImageCacheRef,
    requestCoordinatorRef,
    setCacheRevision,
    setSelectedPageImageDataUrl,
    setSelectedPageImageDataUrlPageId,
    setSelectedPageOriginalImageDataUrl,
    setSelectedPageOriginalImageDataUrlPageId,
  });
  useSelectedPageImageEffect({
    cacheRevision,
    pageImageCacheRef,
    requestCoordinatorRef,
    selectedPageId,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageImageDataUrl,
    setSelectedPageImageDataUrlPageId,
    setSelectedPageOriginalImageDataUrl,
    setSelectedPageOriginalImageDataUrlPageId,
  });
  useOriginalPageImageEffect({
    cacheRevision,
    pageImageCacheRef,
    requestCoordinatorRef,
    selectedPageId,
    selectedPageImageDataUrl,
    selectedPageImageDataUrlPageId,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageOriginalImageDataUrl,
    setSelectedPageOriginalImageDataUrlPageId,
  });
  useNeighborPagePrefetch(
    neighborTargets,
    pageImageCacheRef,
    requestCoordinatorRef,
  );

  return {
    selectedPageImageDataUrl,
    selectedPageImageDataUrlPageId,
    selectedPageOriginalImageDataUrl,
    selectedPageOriginalImageDataUrlPageId,
    clearPageImageCache,
  };
}

function useClearPageImageCache({
  chapterId,
  pageImageCacheRef,
  requestCoordinatorRef,
  setCacheRevision,
  setSelectedPageImageDataUrl,
  setSelectedPageImageDataUrlPageId,
  setSelectedPageOriginalImageDataUrl,
  setSelectedPageOriginalImageDataUrlPageId,
}: {
  chapterId: string | null;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
  requestCoordinatorRef: React.MutableRefObject<PageImageRequestCoordinator>;
  setCacheRevision: React.Dispatch<React.SetStateAction<number>>;
  setSelectedPageImageDataUrl: ImageDataUrlSetter;
  setSelectedPageImageDataUrlPageId: PageImagePageIdSetter;
  setSelectedPageOriginalImageDataUrl: ImageDataUrlSetter;
  setSelectedPageOriginalImageDataUrlPageId: PageImagePageIdSetter;
}): () => void {
  const clearPageImageCache = React.useCallback(() => {
    clearPageImageRequestCache(
      pageImageCacheRef.current,
      requestCoordinatorRef.current,
    );
    setSelectedPageImageDataUrl("");
    setSelectedPageImageDataUrlPageId(null);
    setSelectedPageOriginalImageDataUrl("");
    setSelectedPageOriginalImageDataUrlPageId(null);
    setCacheRevision((revision) => revision + 1);
  }, [
    pageImageCacheRef,
    requestCoordinatorRef,
    setCacheRevision,
    setSelectedPageImageDataUrl,
    setSelectedPageImageDataUrlPageId,
    setSelectedPageOriginalImageDataUrl,
    setSelectedPageOriginalImageDataUrlPageId,
  ]);

  React.useEffect(() => {
    clearPageImageCache();
  }, [chapterId, clearPageImageCache]);
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
  setSelectedPageImageDataUrl,
  setSelectedPageImageDataUrlPageId,
  setSelectedPageOriginalImageDataUrl,
  setSelectedPageOriginalImageDataUrlPageId,
}: {
  cacheRevision: number;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
  requestCoordinatorRef: React.MutableRefObject<PageImageRequestCoordinator>;
  selectedPageId: string | null;
  selectedPageImagePath: string | null;
  selectedPageOriginalImagePath: string | null;
  setSelectedPageImageDataUrl: ImageDataUrlSetter;
  setSelectedPageImageDataUrlPageId: PageImagePageIdSetter;
  setSelectedPageOriginalImageDataUrl: ImageDataUrlSetter;
  setSelectedPageOriginalImageDataUrlPageId: PageImagePageIdSetter;
}): void {
  React.useEffect(() => {
    if (!selectedPageId || !selectedPageOriginalImagePath) {
      setSelectedPageImageDataUrl("");
      setSelectedPageImageDataUrlPageId(null);
      setSelectedPageOriginalImageDataUrl("");
      setSelectedPageOriginalImageDataUrlPageId(null);
      return;
    }

    const imagePath = selectedPageImagePath ?? selectedPageOriginalImagePath;
    setSelectedPageImageDataUrlPageId(null);
    const cacheKey = `${selectedPageId}:${imagePath}`;
    const cached = pageImageCacheRef.current.get(cacheKey);
    if (cached) {
      setSelectedPageImageDataUrl(cached);
      setSelectedPageImageDataUrlPageId(selectedPageId);
      return;
    }

    let cancelled = false;
    void getCachedPageImageDataUrl(
      pageImageCacheRef.current,
      requestCoordinatorRef.current,
      cacheKey,
      imagePath,
    )
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }
        setSelectedPageImageDataUrl(dataUrl);
        setSelectedPageImageDataUrlPageId(selectedPageId);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(error);
          setSelectedPageImageDataUrl("");
          setSelectedPageImageDataUrlPageId(null);
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
    setSelectedPageImageDataUrl,
    setSelectedPageImageDataUrlPageId,
    setSelectedPageOriginalImageDataUrl,
    setSelectedPageOriginalImageDataUrlPageId,
  ]);
}

function useOriginalPageImageEffect({
  cacheRevision,
  pageImageCacheRef,
  requestCoordinatorRef,
  selectedPageId,
  selectedPageImageDataUrl,
  selectedPageImageDataUrlPageId,
  selectedPageImagePath,
  selectedPageOriginalImagePath,
  setSelectedPageOriginalImageDataUrl,
  setSelectedPageOriginalImageDataUrlPageId,
}: OriginalPageImageEffectOptions): void {
  React.useEffect(() => {
    if (!selectedPageId || !selectedPageOriginalImagePath) {
      setSelectedPageOriginalImageDataUrl("");
      setSelectedPageOriginalImageDataUrlPageId(null);
      return;
    }
    if (
      selectedPageImagePath === selectedPageOriginalImagePath &&
      selectedPageImageDataUrl &&
      selectedPageImageDataUrlPageId === selectedPageId
    ) {
      setSelectedPageOriginalImageDataUrl(selectedPageImageDataUrl);
      setSelectedPageOriginalImageDataUrlPageId(selectedPageId);
      return;
    }

    setSelectedPageOriginalImageDataUrlPageId(null);
    const cacheKey = `${selectedPageId}:original:${selectedPageOriginalImagePath}`;
    const cached = pageImageCacheRef.current.get(cacheKey);
    if (cached) {
      setSelectedPageOriginalImageDataUrl(cached);
      setSelectedPageOriginalImageDataUrlPageId(selectedPageId);
      return;
    }

    let cancelled = false;
    setSelectedPageOriginalImageDataUrl("");
    void getCachedPageImageDataUrl(
      pageImageCacheRef.current,
      requestCoordinatorRef.current,
      cacheKey,
      selectedPageOriginalImagePath,
    )
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }
        setSelectedPageOriginalImageDataUrl(dataUrl);
        setSelectedPageOriginalImageDataUrlPageId(selectedPageId);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(error);
          setSelectedPageOriginalImageDataUrl("");
          setSelectedPageOriginalImageDataUrlPageId(null);
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
    selectedPageImageDataUrl,
    selectedPageImageDataUrlPageId,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageOriginalImageDataUrl,
    setSelectedPageOriginalImageDataUrlPageId,
  ]);
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
