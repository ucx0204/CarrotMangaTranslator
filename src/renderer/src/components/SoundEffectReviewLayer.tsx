import React from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { BBox } from "../../../shared/textTypes";
import type { SoundEffectReviewRegion } from "../../../shared/soundEffectReview";
import { resolveVisibleSoundEffectReviewRegions } from "../lib/soundEffectReviewRegions";

type Props = {
  page: MangaPage;
  visible: boolean;
  selectedRegionId: string | null;
  disabled?: boolean;
  onSelectRegion: (regionId: string | null) => void;
  onDismissRegion: (regionId: string) => void;
  onOpenBatch: () => void;
  onExit: () => void;
  onTranslateRegion: (region: SoundEffectReviewRegion) => void;
};

export const SoundEffectReviewLayer = React.memo(
  function SoundEffectReviewLayer({
    disabled = false,
    onDismissRegion,
    onExit,
    onOpenBatch,
    onSelectRegion,
    onTranslateRegion,
    page,
    selectedRegionId,
    visible,
  }: Props): React.JSX.Element | null {
    const { t } = useTranslation("components");
    const regions = React.useMemo(
      () => resolveVisibleSoundEffectReviewRegions(page),
      [page],
    );
    React.useEffect(() => {
      if (!visible) return;
      const handleKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (selectedRegionId) onSelectRegion(null);
        else onExit();
      };
      window.addEventListener("keydown", handleKeyDown, true);
      return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [onExit, onSelectRegion, selectedRegionId, visible]);
    if (!visible || regions.length === 0) return null;
    const selected =
      regions.find((region) => region.id === selectedRegionId) ?? null;
    return (
      <div
        aria-label={t("soundEffectReview.layerLabel")}
        className="sound-effect-review-layer"
        data-sound-effect-review-layer=""
        onClick={(event) => {
          if (event.target === event.currentTarget) onSelectRegion(null);
        }}
      >
        {regions.map((region, index) => (
          <button
            aria-label={t("soundEffectReview.regionLabel", {
              index: index + 1,
              text: region.recognizedText || t("soundEffectReview.unreadable"),
            })}
            aria-pressed={region.id === selected?.id}
            className={`sound-effect-review-box ${region.id === selected?.id ? "is-selected" : ""}`.trim()}
            disabled={disabled}
            key={region.id}
            onClick={(event) => {
              event.stopPropagation();
              onSelectRegion(region.id === selected?.id ? null : region.id);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            style={bboxStyle(region.bbox)}
            type="button"
          >
            <span>{t("soundEffectReview.boxTag")}</span>
          </button>
        ))}
        {selected ? (
          <ReviewActions
            disabled={disabled}
            onDismiss={() => onDismissRegion(selected.id)}
            onOpenBatch={onOpenBatch}
            onTranslate={() => onTranslateRegion(selected)}
            region={selected}
          />
        ) : null}
      </div>
    );
  },
);

function ReviewActions({
  disabled,
  onDismiss,
  onOpenBatch,
  onTranslate,
  region,
}: {
  disabled: boolean;
  onDismiss: () => void;
  onOpenBatch: () => void;
  onTranslate: () => void;
  region: SoundEffectReviewRegion;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div
      className="sound-effect-review-actions"
      onPointerDown={(event) => event.stopPropagation()}
      style={actionStyle(region.bbox)}
    >
      <strong>{t("soundEffectReview.reviewTitle")}</strong>
      <span className="sound-effect-review-reading">
        {region.recognizedText || t("soundEffectReview.unreadable")}
      </span>
      <span>{t("soundEffectReview.inpaintHint")}</span>
      <div>
        <button
          className="sound-effect-review-action-button is-primary"
          disabled={disabled}
          onClick={onOpenBatch}
          type="button"
        >
          {t("soundEffectReview.runAll")}
        </button>
        <button
          className="sound-effect-review-action-button"
          disabled={disabled}
          onClick={onTranslate}
          type="button"
        >
          {t("soundEffectReview.translateOne")}
        </button>
        <button
          className="sound-effect-review-action-button is-dismiss"
          disabled={disabled}
          onClick={onDismiss}
          type="button"
        >
          {t("soundEffectReview.dismiss")}
        </button>
      </div>
    </div>
  );
}

function bboxStyle(bbox: BBox): React.CSSProperties {
  return {
    left: `${bbox.x / 10}%`,
    top: `${bbox.y / 10}%`,
    width: `${bbox.w / 10}%`,
    height: `${bbox.h / 10}%`,
  };
}

function actionStyle(bbox: BBox): React.CSSProperties {
  const alignRight = bbox.x + bbox.w / 2 > 600;
  const placeAbove = bbox.y + bbox.h > 820;
  return {
    ...(alignRight
      ? { right: `${Math.max(0, 1000 - bbox.x - bbox.w) / 10}%` }
      : { left: `${Math.max(0, bbox.x) / 10}%` }),
    ...(placeAbove
      ? { bottom: `${Math.max(0, 1000 - bbox.y) / 10}%` }
      : { top: `${Math.min(970, bbox.y + bbox.h) / 10}%` }),
  };
}
