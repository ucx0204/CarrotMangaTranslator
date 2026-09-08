import React from "react";
import { useTranslation } from "react-i18next";
import sfxIcon from "../assets/images/sfx-script-icon.png";
import { ControlTooltip } from "./ui/ControlTooltip";
import { IconButton } from "./ui/IconButton";
import styles from "./SoundEffectTranslationLauncher.module.css";

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
  if (!available) return null;
  const label = t("soundEffectReview.launcher", { count: pendingCount });
  return (
    <ControlTooltip
      className="sound-effect-translation-launcher-tooltip"
      content={t("soundEffectReview.launcherAction")}
      placement="right"
    >
      <IconButton
        label={label}
        title=""
        variant="dock"
        aria-haspopup="dialog"
        aria-expanded={active}
        className={`sound-effect-translation-launcher ${active ? "is-active" : ""} ${pendingCount <= 0 ? styles.empty : ""}`.trim()}
        disabled={disabled}
        onClick={onOpen}
        type="button"
      >
        <img alt="" aria-hidden="true" src={sfxIcon} />
        <small aria-hidden="true">{pendingCount}</small>
      </IconButton>
    </ControlTooltip>
  );
}
