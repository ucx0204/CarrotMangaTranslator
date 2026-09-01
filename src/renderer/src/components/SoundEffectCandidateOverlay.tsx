import React from "react";
import { useTranslation } from "react-i18next";
import {
  bboxStyle,
  RESIZE_DIRECTIONS,
  type ResizeDirection,
  type SoundEffectDraftRegion,
} from "./soundEffectTranslationDraftModel";
import styles from "./SoundEffectTranslationModal.module.css";

export function SoundEffectCandidateOverlay({
  index,
  region,
  selected,
  onClick,
  onPointerDown,
  onResizePointerDown,
}: {
  index: number;
  region: SoundEffectDraftRegion;
  selected: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onResizePointerDown: (
    event: React.PointerEvent<HTMLSpanElement>,
    direction: ResizeDirection,
  ) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const text = region.recognizedText || t("soundEffectReview.unreadable");
  const state = t(
    region.included
      ? "soundEffectReview.included"
      : "soundEffectReview.excluded",
  );
  return (
    <button
      className={`${styles.candidate} ${region.included ? styles.candidateIncluded : styles.candidateExcluded} ${selected ? styles.candidateSelected : ""}`}
      style={bboxStyle(region.bbox)}
      type="button"
      aria-pressed={region.included}
      aria-label={t("soundEffectReview.candidateToggleLabel", {
        index: index + 1,
        state,
        text,
      })}
      title={text}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event);
      }}
      onPointerDown={onPointerDown}
    >
      {selected
        ? RESIZE_DIRECTIONS.map((direction) => (
            <span
              key={direction}
              className={`${styles.resizeHandle} ${styles[`resize${direction.toUpperCase()}` as keyof typeof styles]}`}
              data-candidate-state={region.included ? "included" : "excluded"}
              data-resize-handle={direction}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => onResizePointerDown(event, direction)}
            />
          ))
        : null}
    </button>
  );
}
