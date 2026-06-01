import React from "react";
import type { MangaPage } from "../../../shared/types";

const PAGE_IMAGE_CACHE_LIMIT = 3;

type UsePageImageDataUrlsOptions = {
  chapterId: string | null;
  selectedPage: MangaPage | null;
  selectedPageImagePath: string | null;
};

type UsePageImageDataUrlsResult = {
  selectedPageImageDataUrl: string;
  selectedPageOriginalImageDataUrl: string;
  clearPageImageCache: () => void;
};

export function usePageImageDataUrls({
  chapterId,
  selectedPage,
  selectedPageImagePath
}: UsePageImageDataUrlsOptions): UsePageImageDataUrlsResult {
  const [selectedPageImageDataUrl, setSelectedPageImageDataUrl] = React.useState("");
  const [selectedPageOriginalImageDataUrl, setSelectedPageOriginalImageDataUrl] = React.useState("");
  const [cacheRevision, setCacheRevision] = React.useState(0);
  const pageImageCacheRef = React.useRef<Map<string, string>>(new Map());

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
    if (!selectedPage) {
      setSelectedPageImageDataUrl("");
      setSelectedPageOriginalImageDataUrl("");
      return;
    }

    const imagePath = selectedPageImagePath ?? selectedPage.imagePath;
    const cacheKey = `${selectedPage.id}:${imagePath}`;
    const cached = pageImageCacheRef.current.get(cacheKey);
    if (cached) {
      setSelectedPageImageDataUrl(cached);
      return;
    }

    let cancelled = false;
    setSelectedPageImageDataUrl("");
    void window.mangaApi
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
  }, [cacheRevision, selectedPage?.id, selectedPageImagePath]);

  React.useEffect(() => {
    if (!selectedPage) {
      setSelectedPageOriginalImageDataUrl("");
      return;
    }
    if (selectedPageImagePath === selectedPage.imagePath && selectedPageImageDataUrl) {
      setSelectedPageOriginalImageDataUrl(selectedPageImageDataUrl);
      return;
    }

    const imagePath = selectedPage.imagePath;
    const cacheKey = `${selectedPage.id}:original:${imagePath}`;
    const cached = pageImageCacheRef.current.get(cacheKey);
    if (cached) {
      setSelectedPageOriginalImageDataUrl(cached);
      return;
    }

    let cancelled = false;
    setSelectedPageOriginalImageDataUrl("");
    void window.mangaApi
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
  }, [cacheRevision, selectedPage?.id, selectedPage?.imagePath, selectedPageImageDataUrl, selectedPageImagePath]);

  return { selectedPageImageDataUrl, selectedPageOriginalImageDataUrl, clearPageImageCache };
}

function setCachedImageDataUrl(cache: Map<string, string>, key: string, dataUrl: string): void {
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
