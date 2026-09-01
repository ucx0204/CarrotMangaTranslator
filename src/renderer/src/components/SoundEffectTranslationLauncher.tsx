import React from "react";
import { useTranslation } from "react-i18next";
import sfxIcon from "../assets/images/sfx-script-icon.png";
import { ControlTooltip } from "./ui/ControlTooltip";

export type SoundEffectTranslationLauncherProps = {
  available: boolean;
  pendingCount: number;
  active?: boolean;
  disabled?: boolean;
  onOpen: () => void;
};

export function SoundEffectTranslationLauncher({
  available,
  pendingCount,
  active = false,
  disabled = false,
  onOpen,
}: SoundEffectTranslationLauncherProps): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!available || pendingCount <= 0) return null;
  const label = t("soundEffectReview.launcher", { count: pendingCount });
  return (
    <ControlTooltip
      className="sound-effect-translation-launcher-tooltip"
      content={t("soundEffectReview.launcherAction")}
      placement="right"
    >
      <button
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={active}
        className={`sound-effect-translation-launcher ${active ? "is-active" : ""}`.trim()}
        disabled={disabled}
        onClick={onOpen}
        type="button"
      >
        <img alt="" aria-hidden="true" src={sfxIcon} />
        <small aria-hidden="true">{pendingCount}</small>
      </button>
    </ControlTooltip>
  );
}
