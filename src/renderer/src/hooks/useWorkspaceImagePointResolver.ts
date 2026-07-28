import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent,
  type RefObject,
} from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { RetouchLiveGeometry } from "../lib/retouchLiveGeometry";
import {
  resolveImagePixelPoint,
  type ImagePoint,
} from "./workspaceInpaintingPointerState";

export type ResolvedImagePoint = {
  geometry: RetouchLiveGeometry;
  point: ImagePoint;
};

export type ImagePointResolver = {
  invalidate: () => void;
  resolve: (
    event: Pick<PointerEvent, "clientX" | "clientY">,
    refreshBounds?: boolean,
  ) => ResolvedImagePoint | null;
};

export function getCoalescedPointerSamples(
  event: PointerEvent,
): Array<Pick<PointerEvent, "clientX" | "clientY">> {
  const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
  if (samples.length === 0) return [event];
  const last = samples[samples.length - 1];
  return last?.clientX === event.clientX && last.clientY === event.clientY
    ? samples
    : [...samples, event];
}

export function useWorkspaceImagePointResolver({
  imageRef,
  selectedPage,
  stageRef,
}: {
  imageRef: RefObject<HTMLImageElement | null>;
  selectedPage: MangaPage | null;
  stageRef: RefObject<HTMLDivElement | null>;
}): ImagePointResolver {
  const boundsRef = useRef<DOMRect | null>(null);
  const invalidate = useCallback(() => {
    boundsRef.current = null;
  }, []);
  const selectedPageId = selectedPage?.id;

  useEffect(() => {
    invalidate();
    const image = imageRef.current;
    const observer =
      image && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(invalidate)
        : null;
    if (image) observer?.observe(image);
    window.addEventListener("resize", invalidate);
    document.addEventListener("scroll", invalidate, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", invalidate);
      document.removeEventListener("scroll", invalidate, true);
    };
  }, [imageRef, invalidate, selectedPageId]);

  const resolve = useCallback(
    (
      event: Pick<PointerEvent, "clientX" | "clientY">,
      refreshBounds = false,
    ) => {
      const stage = stageRef.current;
      const page = selectedPage;
      if (!stage || !page) return null;
      if (refreshBounds || !boundsRef.current) {
        boundsRef.current =
          imageRef.current?.getBoundingClientRect() ??
          stage.getBoundingClientRect();
      }
      const rect = boundsRef.current;
      const point = resolveImagePixelPoint(event, rect, page);
      return point
        ? {
            geometry: {
              displayHeight: rect.height,
              displayWidth: rect.width,
              imageHeight: page.height,
              imageWidth: page.width,
            },
            point,
          }
        : null;
    },
    [imageRef, selectedPage, stageRef],
  );

  return { invalidate, resolve };
}
