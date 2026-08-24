import React from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import { libraryGateway } from "../api/libraryGateway";

/** Registers a thumbnail frame; the returned function unregisters it. */
export type ObservePageThumbnail = (
  element: Element,
  onVisible: () => void,
) => () => void;

type PageThumbnailStatus = "idle" | "loading" | "loaded" | "error";

export type PageThumbnailState = {
  imagePath: string;
  status: PageThumbnailStatus;
  url?: string;
};

const DEFAULT_ROOT_MARGIN = "300px 0px";

/**
 * One IntersectionObserver for a whole scrolling list, instead of one per row.
 * Rows register their frame and are told once when they come near the viewport.
 */
export function usePageThumbnailObserver(
  rootRef: React.RefObject<HTMLElement | null>,
  { rootMargin = DEFAULT_ROOT_MARGIN }: { rootMargin?: string } = {},
): ObservePageThumbnail {
  const callbacksRef = React.useRef<Map<Element, () => void>>(new Map());
  const observerRef = React.useRef<IntersectionObserver | null>(null);

  const observeThumbnail = React.useCallback<ObservePageThumbnail>(
    (element, onVisible) => {
      if (typeof IntersectionObserver === "undefined") {
        onVisible();
        return () => undefined;
      }

      callbacksRef.current.set(element, onVisible);
      observerRef.current?.observe(element);
      return () => {
        if (callbacksRef.current.get(element) !== onVisible) {
          return;
        }
        callbacksRef.current.delete(element);
        observerRef.current?.unobserve(element);
      };
    },
    [],
  );

  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          const onVisible = callbacksRef.current.get(entry.target);
          if (!onVisible) {
            continue;
          }
          callbacksRef.current.delete(entry.target);
          observer.unobserve(entry.target);
          onVisible();
        }
      },
      { root, rootMargin, threshold: 0 },
    );
    observerRef.current = observer;
    for (const element of callbacksRef.current.keys()) {
      observer.observe(element);
    }

    return () => {
      observer.disconnect();
      if (observerRef.current === observer) {
        observerRef.current = null;
      }
    };
  }, [rootMargin, rootRef]);

  return observeThumbnail;
}

/**
 * The single page-thumbnail loader. Waits for the row to come into view, fetches
 * the data URL once, and retries a single time when the decoded image fails, so
 * one transient decode error does not leave a permanent placeholder.
 */
export function usePageThumbnail<Element extends HTMLElement>(
  page: Pick<MangaPage, "imagePath" | "dataUrl">,
  observeThumbnail: ObservePageThumbnail,
): {
  frameRef: React.RefObject<Element | null>;
  state: PageThumbnailState;
  markLoaded: (url: string) => void;
  markErrored: (url: string) => void;
} {
  const frameRef = React.useRef<Element>(null);
  const shouldLoad = useThumbnailVisibility(frameRef, observeThumbnail);
  const load = useThumbnailLoad(page, shouldLoad);
  return { frameRef, ...load };
}

function useThumbnailVisibility(
  frameRef: React.RefObject<HTMLElement | null>,
  observeThumbnail: ObservePageThumbnail,
): boolean {
  const [shouldLoad, setShouldLoad] = React.useState(false);
  React.useEffect(() => {
    const element = frameRef.current;
    if (!element) {
      return;
    }
    return observeThumbnail(element, () => setShouldLoad(true));
  }, [frameRef, observeThumbnail]);
  return shouldLoad;
}

function useThumbnailLoad(
  page: Pick<MangaPage, "imagePath" | "dataUrl">,
  shouldLoad: boolean,
): {
  state: PageThumbnailState;
  markLoaded: (url: string) => void;
  markErrored: (url: string) => void;
} {
  const { imagePath } = page;
  const failureCountRef = React.useRef(0);
  const [requestRevision, setRequestRevision] = React.useState(0);
  const [state, setState] = React.useState<PageThumbnailState>(() =>
    initialState(page),
  );

  React.useEffect(() => {
    failureCountRef.current = 0;
  }, [imagePath]);

  React.useEffect(() => {
    if (!shouldLoad || page.dataUrl) {
      return;
    }
    let cancelled = false;
    setState({ imagePath, status: "loading" });
    const request = requestThumbnail(imagePath);
    if (!request) {
      setState({ imagePath, status: "error" });
      return;
    }
    void request
      .then((url) => {
        if (!cancelled) setState({ imagePath, status: "loading", url });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(error);
        setState({ imagePath, status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [imagePath, page.dataUrl, requestRevision, shouldLoad]);

  const currentState =
    state.imagePath === imagePath ? state : initialState(page);

  const markLoaded = (url: string): void => {
    setState((current) =>
      current.imagePath === imagePath && current.url === url
        ? { ...current, status: "loaded" }
        : current,
    );
  };
  const markErrored = (url: string): void => {
    if (currentState.url !== url) return;
    if (failureCountRef.current === 0) {
      failureCountRef.current = 1;
      setState({ imagePath, status: "loading" });
      setRequestRevision((revision) => revision + 1);
      return;
    }
    setState({ imagePath, status: "error" });
  };
  return { state: currentState, markLoaded, markErrored };
}

/**
 * The preload bridge can be absent (detached panel windows, tests), and that
 * throws synchronously rather than rejecting. Treat it as a load failure so the
 * row shows a placeholder instead of tearing down the list.
 */
function requestThumbnail(imagePath: string): Promise<string> | null {
  try {
    return libraryGateway.getPageImageDataUrl(imagePath);
  } catch (_expectedMissingBridge) {
    return null;
  }
}

/** Pages that already carry an inline data URL skip the fetch entirely. */
function initialState(
  page: Pick<MangaPage, "imagePath" | "dataUrl">,
): PageThumbnailState {
  return page.dataUrl
    ? { imagePath: page.imagePath, status: "loading", url: page.dataUrl }
    : { imagePath: page.imagePath, status: "idle" };
}
