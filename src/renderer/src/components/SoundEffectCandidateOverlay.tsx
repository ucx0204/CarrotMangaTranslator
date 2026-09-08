import { type ResizeDirection } from "../../../shared/regionSelectionGeometry";
import React from "react";
import { useTranslation } from "react-i18next";
import { type SoundEffectDraftRegion } from "./soundEffectTranslationDraftModel";
import { RegionSelectionOverlay } from "./ui/RegionSelectionOverlay";

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
    event: React.PointerEvent<HTMLButtonElement>,
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
    <RegionSelectionOverlay
      bbox={region.bbox}
      selected={selected}
      included={region.included}
      label={t("soundEffectReview.candidateToggleLabel", {
        index: index + 1,
        state,
        text,
      })}
      targetProps={{
        "aria-pressed": region.included,
        title: text,
        onClick: (event) => {
          event.stopPropagation();
          onClick(event);
        },
        onPointerDown,
      }}
      resizeProps={(direction) => ({
        onPointerDown: (event) => onResizePointerDown(event, direction),
      })}
    />
  );
}
