import React from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import { mangaGateway } from "../api/mangaGateway";

const PAGE_IMAGE_CACHE_LIMIT = 6;

type UsePageImageDataUrlsOptions = {
  chapterId: string | null;
  selectedPage: MangaPage | null;
  selectedPageImagePath: string | null;
  /** Adjacent pages to prefetch so flipping swaps from cache without a blank frame. */
  neighborTargets?: Array<{ pageId: string; imagePath: string }>;
};

type UsePageImageDataUrlsResult = {
  selectedPageImageDataUrl: string;
  selectedPageOriginalImageDataUrl: string;
  clearPageImageCache: () => void;
};

type ImageDataUrlSetter = React.Dispatch<React.SetStateAction<string>>;

export function usePageImageDataUrls({
  chapterId,
  selectedPage,
  selectedPageImagePath,
  neighborTargets = [],
}: UsePageImageDataUrlsOptions): UsePageImageDataUrlsResult {
  const [selectedPageImageDataUrl, setSelectedPageImageDataUrl] =
    React.useState("");
  const [
    selectedPageOriginalImageDataUrl,
    setSelectedPageOriginalImageDataUrl,
  ] = React.useState("");
  const [cacheRevision, setCacheRevision] = React.useState(0);
  const pageImageCacheRef = React.useRef<Map<string, string>>(new Map());
  const selectedPageId = selectedPage?.id ?? null;
  const selectedPageOriginalImagePath = selectedPage?.imagePath ?? null;

  const clearPageImageCache = useClearPageImageCache({
    chapterId,
    pageImageCacheRef,
    setCacheRevision,
    setSelectedPageImageDataUrl,
    setSelectedPageOriginalImageDataUrl,
  });
  useSelectedPageImageEffect({
    cacheRevision,
    pageImageCacheRef,
    selectedPageId,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageImageDataUrl,
    setSelectedPageOriginalImageDataUrl,
  });
  useOriginalPageImageEffect({
    cacheRevision,
    pageImageCacheRef,
    selectedPageId,
    selectedPageImageDataUrl,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageOriginalImageDataUrl,
  });
  useNeighborPagePrefetch(neighborTargets, pageImageCacheRef);

  return {
    selectedPageImageDataUrl,
    selectedPageOriginalImageDataUrl,
    clearPageImageCache,
  };
}

function useClearPageImageCache({
  chapterId,
  pageImageCacheRef,
  setCacheRevision,
  setSelectedPageImageDataUrl,
  setSelectedPageOriginalImageDataUrl,
}: {
  chapterId: string | null;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
  setCacheRevision: React.Dispatch<React.SetStateAction<number>>;
  setSelectedPageImageDataUrl: ImageDataUrlSetter;
  setSelectedPageOriginalImageDataUrl: ImageDataUrlSetter;
}): () => void {
  const clearPageImageCache = React.useCallback(() => {
    pageImageCacheRef.current.clear();
    setSelectedPageImageDataUrl("");
    setSelectedPageOriginalImageDataUrl("");
    setCacheRevision((revision) => revision + 1);
  }, [
    pageImageCacheRef,
    setCacheRevision,
    setSelectedPageImageDataUrl,
    setSelectedPageOriginalImageDataUrl,
  ]);

  React.useEffect(() => {
    clearPageImageCache();
  }, [chapterId, clearPageImageCache]);

  return clearPageImageCache;
}

function useSelectedPageImageEffect({
  cacheRevision,
  pageImageCacheRef,
  selectedPageId,
  selectedPageImagePath,
  selectedPageOriginalImagePath,
  setSelectedPageImageDataUrl,
  setSelectedPageOriginalImageDataUrl,
}: {
  cacheRevision: number;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
  selectedPageId: string | null;
  selectedPageImagePath: string | null;
  selectedPageOriginalImagePath: string | null;
  setSelectedPageImageDataUrl: ImageDataUrlSetter;
  setSelectedPageOriginalImageDataUrl: ImageDataUrlSetter;
}): void {
  React.useEffect(() => {
    if (!selectedPageId || !selectedPageOriginalImagePath) {
      setSelectedPageImageDataUrl("");
      setSelectedPageOriginalImageDataUrl("");
      return;
    }

    const imagePath = selectedPageImagePath ?? selectedPageOriginalImagePath;
    const cacheKey = `${selectedPageId}:${imagePath}`;
    const cached = pageImageCacheRef.current.get(cacheKey);
    if (cached) {
      setSelectedPageImageDataUrl(cached);
      return;
    }

    let cancelled = false;
    void mangaGateway
      .getPageImageDataUrl(imagePath)
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }
        setCachedImageDataUrl(pageImageCacheRef.current, cacheKey, dataUrl);
        setSelectedPageImageDataUrl(dataUrl);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(error);
          setSelectedPageImageDataUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    cacheRevision,
    pageImageCacheRef,
    selectedPageId,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageImageDataUrl,
    setSelectedPageOriginalImageDataUrl,
  ]);
}

function useOriginalPageImageEffect({
  cacheRevision,
  pageImageCacheRef,
  selectedPageId,
  selectedPageImageDataUrl,
  selectedPageImagePath,
  selectedPageOriginalImagePath,
  setSelectedPageOriginalImageDataUrl,
}: {
  cacheRevision: number;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
  selectedPageId: string | null;
  selectedPageImageDataUrl: string;
  selectedPageImagePath: string | null;
  selectedPageOriginalImagePath: string | null;
  setSelectedPageOriginalImageDataUrl: ImageDataUrlSetter;
}): void {
  React.useEffect(() => {
    if (!selectedPageId || !selectedPageOriginalImagePath) {
      setSelectedPageOriginalImageDataUrl("");
      return;
    }
    if (
      selectedPageImagePath === selectedPageOriginalImagePath &&
      selectedPageImageDataUrl
    ) {
      setSelectedPageOriginalImageDataUrl(selectedPageImageDataUrl);
      return;
    }

    const cacheKey = `${selectedPageId}:original:${selectedPageOriginalImagePath}`;
    const cached = pageImageCacheRef.current.get(cacheKey);
    if (cached) {
      setSelectedPageOriginalImageDataUrl(cached);
      return;
    }

    let cancelled = false;
    setSelectedPageOriginalImageDataUrl("");
    void mangaGateway
      .getPageImageDataUrl(selectedPageOriginalImagePath)
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }
        setCachedImageDataUrl(pageImageCacheRef.current, cacheKey, dataUrl);
        setSelectedPageOriginalImageDataUrl(dataUrl);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(error);
          setSelectedPageOriginalImageDataUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    cacheRevision,
    pageImageCacheRef,
    selectedPageId,
    selectedPageImageDataUrl,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageOriginalImageDataUrl,
  ]);
}

function useNeighborPagePrefetch(
  neighborTargets: Array<{ pageId: string; imagePath: string }>,
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>,
): void {
  React.useEffect(() => {
    if (neighborTargets.length === 0) {
      return;
    }
    let cancelled = false;
    for (const target of neighborTargets) {
      const cacheKey = `${target.pageId}:${target.imagePath}`;
      if (pageImageCacheRef.current.has(cacheKey)) {
        continue;
      }
      void mangaGateway
        .getPageImageDataUrl(target.imagePath)
        .then((dataUrl) => {
          if (!cancelled) {
            setCachedImageDataUrl(pageImageCacheRef.current, cacheKey, dataUrl);
          }
        })
        .catch((error) => {
          console.warn("이웃 페이지 미리 불러오기 실패", error);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [neighborTargets, pageImageCacheRef]);
}

function setCachedImageDataUrl(
  cache: Map<string, string>,
  key: string,
  dataUrl: string,
): void {
  cache.delete(key);
  cache.set(key, dataUrl);
  while (cache.size > PAGE_IMAGE_CACHE_LIMIT) {
    const oldestPageId = cache.keys().next().value;
    if (!oldestPageId) {
      break;
    }
    cache.delete(oldestPageId);
  }
}
