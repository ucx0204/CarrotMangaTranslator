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

type WorkspaceZoomStyleInput = {
  containerRef: RefObject<HTMLElement | null>;
  fitMode: WorkspaceFitMode;
  imageRef: RefObject<HTMLImageElement | null>;
  imageRevision: string;
  page: PageAspect | null;
  zoom: number;
};

type ObservedImageSize = PageAspect & {
  revision: string;
};

/**
 * Resolve the CSS variables/class that apply the selected fit and zoom. The
 * page image is sized explicitly so the image and overlays scale together and
 * the workspace can scroll without pointer-coordinate drift.
 */
export function useWorkspaceZoomStyle({
  containerRef,
  fitMode,
  imageRef,
  imageRevision,
  page,
  zoom,
}: WorkspaceZoomStyleInput): WorkspaceZoomStyle {
  const [container, setContainer] = useState<ContainerSize | null>(null);
  const observedImageSize = useObservedImageSize({
    imageRef,
    page,
    revision: imageRevision,
  });

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

  const imageAspect =
    observedImageSize?.revision === imageRevision ? observedImageSize : page;
  const imageSize = computeWorkspaceImageSize(
    zoom,
    fitMode,
    imageAspect,
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

function useObservedImageSize({
  imageRef,
  page,
  revision,
}: {
  imageRef: RefObject<HTMLImageElement | null>;
  page: PageAspect | null;
  revision: string;
}): ObservedImageSize | null {
  const [observed, setObserved] = useState<ObservedImageSize | null>(null);

  useLayoutEffect(() => {
    const clear = (): void =>
      setObserved((current) => (current === null ? current : null));
    setObserved((current) => (current?.revision === revision ? current : null));
    const image = imageRef.current;
    if (!image || !revision) return;
    const sync = (): void => {
      const next = readNaturalImageSize(image, revision);
      if (!next) return;
      if (next.width === page?.width && next.height === page.height) {
        clear();
        return;
      }
      setObserved((current) =>
        current?.revision === next.revision &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    sync();
    image.addEventListener("load", sync);
    image.addEventListener("error", clear);
    return () => {
      image.removeEventListener("load", sync);
      image.removeEventListener("error", clear);
    };
  }, [imageRef, page?.height, page?.width, revision]);

  return observed;
}

function readNaturalImageSize(
  image: HTMLImageElement,
  revision: string,
): ObservedImageSize | null {
  if (
    image.getAttribute("src") !== revision ||
    !image.complete ||
    image.naturalWidth < 1 ||
    image.naturalHeight < 1
  ) {
    return null;
  }
  return {
    height: image.naturalHeight,
    revision,
    width: image.naturalWidth,
  };
}
