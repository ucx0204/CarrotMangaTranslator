import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  computeWorkspaceImageSize,
  type ContainerSize,
  type PageAspect,
  type WorkspaceFitMode,
} from "../lib/workspaceZoom";

type WorkspaceZoomStyle = {
  className: string;
  style: CSSProperties | undefined;
};

/**
 * Resolve the CSS variables/class that apply the selected fit and zoom. The
 * page image is sized explicitly so the image and overlays scale together and
 * the workspace can scroll without pointer-coordinate drift.
 */
export function useWorkspaceZoomStyle(
  zoom: number,
  fitMode: WorkspaceFitMode,
  page: PageAspect | null,
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

  const imageSize = computeWorkspaceImageSize(zoom, fitMode, page, container);
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
