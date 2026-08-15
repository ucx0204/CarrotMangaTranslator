import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  computeWorkspaceOverscroll,
  computeWorkspaceImageSize,
  computeWorkspaceScrollOrigin,
  doesWorkspacePageFit,
  type ContainerSize,
  type PageAspect,
  type WorkspaceOverscroll,
  type WorkspaceScrollOrigin,
  type WorkspaceFitMode,
} from "../lib/workspaceZoom";

type WorkspaceZoomStyle = {
  className: string;
  effectiveScale: number | null;
  overscroll: WorkspaceOverscroll | null;
  pageFits: boolean;
  scrollOrigin: WorkspaceScrollOrigin | null;
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
  const container = useObservedContainerSize(containerRef);
  const observedImageSize = useObservedImageSize({
    imageRef,
    page,
    revision: imageRevision,
  });
  const imageAspect =
    observedImageSize?.revision === imageRevision ? observedImageSize : page;
  return resolveWorkspaceZoomStyle({ container, fitMode, imageAspect, zoom });
}

function useObservedContainerSize(
  containerRef: RefObject<HTMLElement | null>,
): ContainerSize | null {
  const [container, setContainer] = useState<ContainerSize | null>(null);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const sync = (): void =>
      setContainer((current) => retainEqualContainerSize(current, element));
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);
  return container;
}

function retainEqualContainerSize(
  current: ContainerSize | null,
  element: HTMLElement,
): ContainerSize {
  const next = { width: element.clientWidth, height: element.clientHeight };
  const unchanged =
    current &&
    Math.abs(current.width - next.width) < 0.5 &&
    Math.abs(current.height - next.height) < 0.5;
  return unchanged ? current : next;
}

function resolveWorkspaceZoomStyle({
  container,
  fitMode,
  imageAspect,
  zoom,
}: {
  container: ContainerSize | null;
  fitMode: WorkspaceFitMode;
  imageAspect: PageAspect | null;
  zoom: number;
}): WorkspaceZoomStyle {
  const imageSize = computeWorkspaceImageSize(
    zoom,
    fitMode,
    imageAspect,
    container,
  );
  if (!imageSize || !imageAspect) {
    return {
      className: "",
      effectiveScale: null,
      overscroll: container ? { x: 0, y: 0 } : null,
      pageFits: false,
      scrollOrigin: null,
      style: undefined,
    };
  }
  const pageFits = container
    ? doesWorkspacePageFit(imageSize, container)
    : false;
  const overscroll = resolveWorkspaceOverscroll(container, pageFits);
  return {
    className: "is-zoomed",
    effectiveScale: imageSize.width / imageAspect.width,
    overscroll,
    pageFits,
    scrollOrigin: resolveWorkspaceScrollOrigin(
      container,
      imageSize,
      overscroll,
      pageFits,
    ),
    style: {
      "--page-display-w": `${imageSize.width}px`,
      "--page-display-h": `${imageSize.height}px`,
      "--workspace-overscroll-x": `${overscroll?.x ?? 0}px`,
      "--workspace-overscroll-y": `${overscroll?.y ?? 0}px`,
    } as CSSProperties,
  };
}

function resolveWorkspaceOverscroll(
  container: ContainerSize | null,
  pageFits: boolean,
): WorkspaceOverscroll | null {
  if (!container) return null;
  return pageFits ? { x: 0, y: 0 } : computeWorkspaceOverscroll(container);
}

function resolveWorkspaceScrollOrigin(
  container: ContainerSize | null,
  imageSize: PageAspect,
  overscroll: WorkspaceOverscroll | null,
  pageFits: boolean,
): WorkspaceScrollOrigin | null {
  if (pageFits) return { x: 0, y: 0 };
  if (!container || !overscroll) return null;
  return computeWorkspaceScrollOrigin(container, imageSize, overscroll);
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
