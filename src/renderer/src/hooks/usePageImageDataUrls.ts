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
  selectedPageImageDataUrlPageId: string | null;
  selectedPageOriginalImageDataUrl: string;
  selectedPageOriginalImageDataUrlPageId: string | null;
  clearPageImageCache: () => void;
};

type ImageDataUrlSetter = React.Dispatch<React.SetStateAction<string>>;
type PageImagePageIdSetter = React.Dispatch<
  React.SetStateAction<string | null>
>;

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
  const [selectedPageImageDataUrlPageId, setSelectedPageImageDataUrlPageId] =
    React.useState<string | null>(null);
  const [
    selectedPageOriginalImageDataUrlPageId,
    setSelectedPageOriginalImageDataUrlPageId,
  ] = React.useState<string | null>(null);
  const [cacheRevision, setCacheRevision] = React.useState(0);
  const pageImageCacheRef = React.useRef<Map<string, string>>(new Map());
  const selectedPageId = selectedPage?.id ?? null;
  const selectedPageOriginalImagePath = selectedPage?.imagePath ?? null;

  const clearPageImageCache = useClearPageImageCache({
    chapterId,
    pageImageCacheRef,
    setCacheRevision,
    setSelectedPageImageDataUrl,
    setSelectedPageImageDataUrlPageId,
    setSelectedPageOriginalImageDataUrl,
    setSelectedPageOriginalImageDataUrlPageId,
  });
  useSelectedPageImageEffect({
    cacheRevision,
    pageImageCacheRef,
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
    selectedPageId,
    selectedPageImageDataUrl,
    selectedPageImageDataUrlPageId,
    selectedPageImagePath,
    selectedPageOriginalImagePath,
    setSelectedPageOriginalImageDataUrl,
    setSelectedPageOriginalImageDataUrlPageId,
  });
  useNeighborPagePrefetch(neighborTargets, pageImageCacheRef);

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
  setCacheRevision,
  setSelectedPageImageDataUrl,
  setSelectedPageImageDataUrlPageId,
  setSelectedPageOriginalImageDataUrl,
  setSelectedPageOriginalImageDataUrlPageId,
}: {
  chapterId: string | null;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
  setCacheRevision: React.Dispatch<React.SetStateAction<number>>;
  setSelectedPageImageDataUrl: ImageDataUrlSetter;
  setSelectedPageImageDataUrlPageId: PageImagePageIdSetter;
  setSelectedPageOriginalImageDataUrl: ImageDataUrlSetter;
  setSelectedPageOriginalImageDataUrlPageId: PageImagePageIdSetter;
}): () => void {
  const clearPageImageCache = React.useCallback(() => {
    pageImageCacheRef.current.clear();
    setSelectedPageImageDataUrl("");
    setSelectedPageImageDataUrlPageId(null);
    setSelectedPageOriginalImageDataUrl("");
    setSelectedPageOriginalImageDataUrlPageId(null);
    setCacheRevision((revision) => revision + 1);
  }, [
    pageImageCacheRef,
    setCacheRevision,
    setSelectedPageImageDataUrl,
    setSelectedPageImageDataUrlPageId,
    setSelectedPageOriginalImageDataUrl,
    setSelectedPageOriginalImageDataUrlPageId,
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
  setSelectedPageImageDataUrlPageId,
  setSelectedPageOriginalImageDataUrl,
  setSelectedPageOriginalImageDataUrlPageId,
}: {
  cacheRevision: number;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
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
    void mangaGateway
      .getPageImageDataUrl(imagePath)
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }
        setCachedImageDataUrl(pageImageCacheRef.current, cacheKey, dataUrl);
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
  selectedPageId,
  selectedPageImageDataUrl,
  selectedPageImageDataUrlPageId,
  selectedPageImagePath,
  selectedPageOriginalImagePath,
  setSelectedPageOriginalImageDataUrl,
  setSelectedPageOriginalImageDataUrlPageId,
}: {
  cacheRevision: number;
  pageImageCacheRef: React.MutableRefObject<Map<string, string>>;
  selectedPageId: string | null;
  selectedPageImageDataUrl: string;
  selectedPageImageDataUrlPageId: string | null;
  selectedPageImagePath: string | null;
  selectedPageOriginalImagePath: string | null;
  setSelectedPageOriginalImageDataUrl: ImageDataUrlSetter;
  setSelectedPageOriginalImageDataUrlPageId: PageImagePageIdSetter;
}): void {
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
    void mangaGateway
      .getPageImageDataUrl(selectedPageOriginalImagePath)
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }
        setCachedImageDataUrl(pageImageCacheRef.current, cacheKey, dataUrl);
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
