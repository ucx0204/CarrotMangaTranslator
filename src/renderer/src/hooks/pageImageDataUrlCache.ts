import { libraryGateway as mangaGateway } from "../api/libraryGateway";

const PAGE_IMAGE_CACHE_LIMIT = 6;
const PAGE_IMAGE_PRELOAD_LIMIT = 4;

export type PageImageRequestCoordinator = {
  epoch: number;
  inFlightByPath: Map<string, Promise<string>>;
  preloadInFlightByUrl: Map<string, Promise<HTMLImageElement>>;
  preloadedByUrl: Map<string, HTMLImageElement>;
};

export function createPageImageRequestCoordinator(): PageImageRequestCoordinator {
  return {
    epoch: 0,
    inFlightByPath: new Map(),
    preloadInFlightByUrl: new Map(),
    preloadedByUrl: new Map(),
  };
}

export function clearPageImageRequestCache(
  cache: Map<string, string>,
  coordinator: PageImageRequestCoordinator,
): void {
  cache.clear();
  coordinator.epoch += 1;
  coordinator.inFlightByPath.clear();
  coordinator.preloadInFlightByUrl.clear();
  clearPreloadedPageImages(coordinator.preloadedByUrl);
}

export function getCachedPageImageDataUrl(
  cache: Map<string, string>,
  coordinator: PageImageRequestCoordinator,
  cacheKey: string,
  imagePath: string,
): Promise<string> {
  const cached = cache.get(cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }
  const epoch = coordinator.epoch;
  const request =
    coordinator.inFlightByPath.get(imagePath) ??
    createTrackedPageImageRequest(coordinator, imagePath);
  return request.then((dataUrl) => {
    if (coordinator.epoch === epoch) {
      setCachedImageDataUrl(cache, cacheKey, dataUrl);
    }
    return dataUrl;
  });
}

export function preloadPageImage(
  coordinator: PageImageRequestCoordinator,
  dataUrl: string,
): Promise<void> {
  const preloaded = coordinator.preloadedByUrl.get(dataUrl);
  if (preloaded) {
    coordinator.preloadedByUrl.delete(dataUrl);
    coordinator.preloadedByUrl.set(dataUrl, preloaded);
    return Promise.resolve();
  }
  if (typeof Image === "undefined") {
    return Promise.resolve();
  }

  const epoch = coordinator.epoch;
  const request =
    coordinator.preloadInFlightByUrl.get(dataUrl) ??
    createTrackedPageImagePreload(coordinator, dataUrl);
  return request.then((image) => {
    if (coordinator.epoch !== epoch) {
      image.removeAttribute("src");
      return;
    }
    setPreloadedPageImage(coordinator.preloadedByUrl, dataUrl, image);
  });
}

function createTrackedPageImageRequest(
  coordinator: PageImageRequestCoordinator,
  imagePath: string,
): Promise<string> {
  const request = Promise.resolve().then(() =>
    mangaGateway.getPageImageDataUrl(imagePath),
  );
  coordinator.inFlightByPath.set(imagePath, request);
  void request.then(
    () => clearTrackedPageImageRequest(coordinator, imagePath, request),
    () => clearTrackedPageImageRequest(coordinator, imagePath, request),
  );
  return request;
}

function clearTrackedPageImageRequest(
  coordinator: PageImageRequestCoordinator,
  imagePath: string,
  request: Promise<string>,
): void {
  if (coordinator.inFlightByPath.get(imagePath) === request) {
    coordinator.inFlightByPath.delete(imagePath);
  }
}

function createTrackedPageImagePreload(
  coordinator: PageImageRequestCoordinator,
  dataUrl: string,
): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  const request = decodePageImage(image, dataUrl).then(() => image);
  coordinator.preloadInFlightByUrl.set(dataUrl, request);
  void request.then(
    () => clearTrackedPageImagePreload(coordinator, dataUrl, request),
    () => clearTrackedPageImagePreload(coordinator, dataUrl, request),
  );
  return request;
}

function decodePageImage(
  image: HTMLImageElement,
  dataUrl: string,
): Promise<void> {
  if (typeof image.decode === "function") {
    image.src = dataUrl;
    return image.decode();
  }
  return new Promise((resolve, reject) => {
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      resolve();
    };
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
      reject(new Error("Neighbor page image failed to preload."));
    };
    image.src = dataUrl;
  });
}

function clearTrackedPageImagePreload(
  coordinator: PageImageRequestCoordinator,
  dataUrl: string,
  request: Promise<HTMLImageElement>,
): void {
  if (coordinator.preloadInFlightByUrl.get(dataUrl) === request) {
    coordinator.preloadInFlightByUrl.delete(dataUrl);
  }
}

function setPreloadedPageImage(
  preloadedByUrl: Map<string, HTMLImageElement>,
  dataUrl: string,
  image: HTMLImageElement,
): void {
  preloadedByUrl.delete(dataUrl);
  preloadedByUrl.set(dataUrl, image);
  while (preloadedByUrl.size > PAGE_IMAGE_PRELOAD_LIMIT) {
    const oldestUrl = preloadedByUrl.keys().next().value;
    if (!oldestUrl) {
      return;
    }
    preloadedByUrl.get(oldestUrl)?.removeAttribute("src");
    preloadedByUrl.delete(oldestUrl);
  }
}

function clearPreloadedPageImages(
  preloadedByUrl: Map<string, HTMLImageElement>,
): void {
  for (const image of preloadedByUrl.values()) {
    image.removeAttribute("src");
  }
  preloadedByUrl.clear();
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
      return;
    }
    cache.delete(oldestPageId);
  }
}
