import { useLayoutEffect, useState, type RefObject } from "react";
import type { ViewportSize } from "../lib/overlayLayout";

export function useStageSize(
  imageRef: RefObject<HTMLImageElement | null>,
  fallback: ViewportSize | null,
  revision?: string | null,
): ViewportSize | null {
  const [stageSize, setStageSize] = useState<ViewportSize | null>(null);
  const fallbackWidth = fallback?.width ?? null;
  const fallbackHeight = fallback?.height ?? null;

  useLayoutEffect(() => {
    let frameId = 0;
    const fallbackSize =
      fallbackWidth !== null && fallbackHeight !== null
        ? { width: fallbackWidth, height: fallbackHeight }
        : null;

    const readImageSize = () => {
      const image = imageRef.current;
      if (!image) {
        return fallbackSize;
      }

      const rect = image.getBoundingClientRect();
      const width = rect.width || image.clientWidth || 0;
      const height = rect.height || image.clientHeight || 0;
      if (width > 0 && height > 0) {
        return { width, height };
      }
      return image.complete ? fallbackSize : null;
    };

    const syncStageSize = () => {
      const next = readImageSize();
      setStageSize((current) => {
        if (
          current &&
          next &&
          Math.abs(current.width - next.width) < 0.5 &&
          Math.abs(current.height - next.height) < 0.5
        ) {
          return current;
        }
        return next;
      });
    };

    const scheduleSync = () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        syncStageSize();
      });
    };

    const image = imageRef.current;
    if (!image) {
      setStageSize(null);
      return;
    }

    syncStageSize();
    const observer = new ResizeObserver(() => scheduleSync());
    observer.observe(image);
    if (image.parentElement) {
      observer.observe(image.parentElement);
    }
    image.addEventListener("load", scheduleSync);
    window.addEventListener("resize", scheduleSync);

    return () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      observer.disconnect();
      image.removeEventListener("load", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
    };
  }, [fallbackHeight, fallbackWidth, imageRef, revision]);

  return stageSize;
}
