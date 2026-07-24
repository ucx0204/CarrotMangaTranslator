import React from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import { libraryGateway as mangaGateway } from "../api/libraryGateway";
import type { TriState } from "../lib/translationSelection";
import { SelectionCard } from "./ui/SelectionCard";

export type ObservePageThumbnail = (
  element: Element,
  onVisible: () => void,
) => () => void;

type ThumbnailLoadStatus = "idle" | "loading" | "loaded" | "error";

type ThumbnailLoadState = {
  imagePath: string;
  status: ThumbnailLoadStatus;
  url?: string;
};

function useThumbnailVisibility(
  observeThumbnail: ObservePageThumbnail,
): [React.RefObject<HTMLSpanElement | null>, boolean] {
  const imageFrameRef = React.useRef<HTMLSpanElement>(null);
  const [shouldLoad, setShouldLoad] = React.useState(false);
  React.useEffect(() => {
    const element = imageFrameRef.current;
    if (!element) {
      return;
    }
    return observeThumbnail(element, () => setShouldLoad(true));
  }, [observeThumbnail]);
  return [imageFrameRef, shouldLoad];
}

function useThumbnailLoad(
  imagePath: string,
  shouldLoad: boolean,
): {
  loadState: ThumbnailLoadState;
  markImageLoaded: (url: string) => void;
  markImageErrored: (url: string) => void;
} {
  const imageFailureCountRef = React.useRef(0);
  const [requestRevision, setRequestRevision] = React.useState(0);
  const [loadState, setLoadState] = React.useState<ThumbnailLoadState>({
    imagePath,
    status: "idle",
  });

  React.useEffect(() => {
    imageFailureCountRef.current = 0;
  }, [imagePath]);

  React.useEffect(() => {
    if (!shouldLoad) {
      return;
    }
    let cancelled = false;
    setLoadState({ imagePath, status: "loading" });
    void mangaGateway
      .getPageImageDataUrl(imagePath)
      .then((url) => {
        if (!cancelled) {
          setLoadState({ imagePath, status: "loading", url });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error(error);
          setLoadState({ imagePath, status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [imagePath, requestRevision, shouldLoad]);

  const currentLoadState =
    loadState.imagePath === imagePath
      ? loadState
      : { imagePath, status: "idle" as const };
  const markImageLoaded = (url: string): void => {
    setLoadState((current) =>
      current.imagePath === imagePath && current.url === url
        ? { ...current, status: "loaded" }
        : current,
    );
  };
  const markImageErrored = (url: string): void => {
    if (currentLoadState.url !== url) {
      return;
    }
    if (imageFailureCountRef.current === 0) {
      imageFailureCountRef.current = 1;
      setLoadState({ imagePath, status: "loading" });
      setRequestRevision((revision) => revision + 1);
      return;
    }
    setLoadState({ imagePath, status: "error" });
  };
  return { loadState: currentLoadState, markImageLoaded, markImageErrored };
}

export function PageThumb({
  page,
  index,
  checked,
  showTranslatedStatus = true,
  observeThumbnail,
  onToggle,
}: {
  page: MangaPage;
  index: number;
  checked: boolean;
  showTranslatedStatus?: boolean;
  observeThumbnail: ObservePageThumbnail;
  onToggle: () => void;
}): React.JSX.Element {
  const [imageFrameRef, shouldLoad] = useThumbnailVisibility(observeThumbnail);
  const { loadState, markImageLoaded, markImageErrored } = useThumbnailLoad(
    page.imagePath,
    shouldLoad,
  );
  const done = showTranslatedStatus && page.analysisStatus === "completed";
  return (
    <SelectionCard
      className={["translate-page-thumb", done ? "done" : ""]
        .filter(Boolean)
        .join(" ")}
      variant="thumbnail"
      inputType="checkbox"
      inputClassName="translate-page-thumb-check"
      checked={checked}
      onChange={onToggle}
    >
      <ThumbnailImage
        frameRef={imageFrameRef}
        pageName={page.name}
        done={done}
        loadState={loadState}
        onLoad={markImageLoaded}
        onError={markImageErrored}
      />
      <span className="translate-page-thumb-cap" title={page.name}>
        <span className="translate-page-thumb-no">{index + 1}</span>
        <span className="translate-page-thumb-name">{page.name}</span>
      </span>
    </SelectionCard>
  );
}

function ThumbnailImage({
  frameRef,
  pageName,
  done,
  loadState,
  onLoad,
  onError,
}: {
  frameRef: React.RefObject<HTMLSpanElement | null>;
  pageName: string;
  done: boolean;
  loadState: ThumbnailLoadState;
  onLoad: (url: string) => void;
  onError: (url: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const url = loadState.url;
  return (
    <span
      ref={frameRef}
      className="translate-page-thumb-img"
      data-image-state={loadState.status}
      aria-busy={loadState.status === "loading" || undefined}
    >
      {loadState.status === "error" ? (
        <span
          className="translate-page-thumb-error"
          role="img"
          aria-label={t("chapterPicker.thumbnailLoadFailed")}
        >
          {t("chapterPicker.thumbnailLoadFailed")}
        </span>
      ) : url ? (
        <img
          src={url}
          alt={pageName}
          loading="lazy"
          draggable={false}
          onLoad={() => onLoad(url)}
          onError={() => onError(url)}
        />
      ) : (
        <span className="translate-page-thumb-skeleton" aria-hidden="true" />
      )}
      {done ? (
        <span
          className="translate-page-thumb-badge"
          aria-label={t("chapterPicker.translated")}
        >
          ✓
        </span>
      ) : null}
    </span>
  );
}

export function TriCheckbox({
  state,
  label,
  onChange,
}: {
  state: TriState;
  label: string;
  onChange: () => void;
}): React.JSX.Element {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = state === "some";
    }
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="translate-chapter-check"
      aria-label={label}
      checked={state === "all"}
      onChange={onChange}
    />
  );
}
