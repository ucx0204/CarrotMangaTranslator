import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import {
  computeWorkspaceImageSize,
  type ContainerSize,
} from "../lib/workspaceZoom";

type WorkspaceZoomStyle = {
  className: string;
  style: CSSProperties | undefined;
};

/**
 * Resolve the CSS variables/class that apply the workspace zoom. At zoom 1 it
 * returns nothing so the default responsive CSS fit is used unchanged. Above/
 * below 1 it sizes the page image explicitly (via custom properties) so the
 * image and its overlays scale together and the workspace can scroll.
 */
export function useWorkspaceZoomStyle(
  zoom: number,
  page: MangaPage | null,
  containerRef: RefObject<HTMLElement | null>,
): WorkspaceZoomStyle {
  const [container, setContainer] = useState<ContainerSize | null>(null);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const sync = (): void =>
      setContainer((current) => {
        const next = {
          width: element.clientWidth,
          height: element.clientHeight,
        };
        return current &&
          Math.abs(current.width - next.width) < 0.5 &&
          Math.abs(current.height - next.height) < 0.5
          ? current
          : next;
      });
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  const imageSize = computeWorkspaceImageSize(
    zoom,
    page ? { width: page.width, height: page.height } : null,
    container,
  );
  if (!imageSize) {
    return { className: "", style: undefined };
  }
  return {
    className: "is-zoomed",
    style: {
      "--page-display-w": `${imageSize.width}px`,
      "--page-display-h": `${imageSize.height}px`,
    } as CSSProperties,
  };
}
