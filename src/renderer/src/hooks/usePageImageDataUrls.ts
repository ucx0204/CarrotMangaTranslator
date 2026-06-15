import React from "react";
import type { MangaPage } from "../../../shared/types";
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

  const clearPageImageCache = React.useCallback(() => {
    pageImageCacheRef.current.clear();
    setSelectedPageImageDataUrl("");
    setSelectedPageOriginalImageDataUrl("");
    setCacheRevision((revision) => revision + 1);
  }, []);

  React.useEffect(() => {
    clearPageImageCache();
  }, [chapterId, clearPageImageCache]);

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

    // Keep the previous page visible until the next one resolves so flipping
    // pages never flashes the dark placeholder.
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
    selectedPageId,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
  ]);

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

    const imagePath = selectedPageOriginalImagePath;
    const cacheKey = `${selectedPageId}:original:${imagePath}`;
    const cached = pageImageCacheRef.current.get(cacheKey);
    if (cached) {
      setSelectedPageOriginalImageDataUrl(cached);
      return;
    }

    let cancelled = false;
    setSelectedPageOriginalImageDataUrl("");
    void mangaGateway
      .getPageImageDataUrl(imagePath)
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
    selectedPageId,
    selectedPageImageDataUrl,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
  ]);

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
  }, [neighborTargets]);

  return {
    selectedPageImageDataUrl,
    selectedPageOriginalImageDataUrl,
    clearPageImageCache,
  };
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
