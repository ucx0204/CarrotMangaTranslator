import React from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TriState } from "../lib/translationSelection";
import {
  usePageThumbnail,
  type ObservePageThumbnail,
  type PageThumbnailState,
} from "./pageThumbnails";
import { CheckboxField } from "./ui/CheckboxField";
import {
  PageThumbSelectionCard,
  type PageThumbSelectionState,
} from "./PageThumbSelectionCard";

export function PageThumb({
  page,
  index,
  checked,
  selectionState,
  selectionTooltip,
  showTranslatedStatus = true,
  observeThumbnail,
  onToggle,
}: {
  page: MangaPage;
  index: number;
  checked: boolean;
  selectionState?: PageThumbSelectionState;
  selectionTooltip?: string;
  showTranslatedStatus?: boolean;
  observeThumbnail: ObservePageThumbnail;
  onToggle: () => void;
}): React.JSX.Element {
  const { frameRef, state, markLoaded, markErrored } =
    usePageThumbnail<HTMLSpanElement>(page, observeThumbnail);
  const done = showTranslatedStatus && page.analysisStatus === "completed";
  return (
    <PageThumbSelectionCard
      checked={checked}
      className={["translate-page-thumb", done ? "done" : ""]
        .filter(Boolean)
        .join(" ")}
      onToggle={onToggle}
      selectionState={selectionState}
      selectionTooltip={selectionTooltip}
    >
      <ThumbnailImage
        frameRef={frameRef}
        pageName={page.name}
        done={done}
        loadState={state}
        onLoad={markLoaded}
        onError={markErrored}
      />
      <span className="translate-page-thumb-cap" title={page.name}>
        <span className="translate-page-thumb-no">{index + 1}</span>
        <span className="translate-page-thumb-name">{page.name}</span>
      </span>
    </PageThumbSelectionCard>
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
  loadState: PageThumbnailState;
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
  return (
    <CheckboxField
      className="translate-chapter-check"
      ariaLabel={label}
      checked={state === "all"}
      indeterminate={state === "some"}
      onCheckedChange={onChange}
    />
  );
}
