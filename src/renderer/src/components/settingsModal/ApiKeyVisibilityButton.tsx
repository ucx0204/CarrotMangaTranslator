import React from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../ui/IconButton";
import { EyeIcon, EyeOffIcon } from "../ui/icons";

export function ApiKeyVisibilityButton({
  controlsBusy,
  setShowApiKey,
  showApiKey,
}: {
  controlsBusy: boolean;
  setShowApiKey: (value: boolean) => void;
  showApiKey: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <IconButton
      label={showApiKey ? t("settings.api.hideKey") : t("settings.api.showKey")}
      aria-pressed={showApiKey}
      disabled={controlsBusy}
      onClick={() => setShowApiKey(!showApiKey)}
    >
      {showApiKey ? <EyeOffIcon /> : <EyeIcon />}
    </IconButton>
  );
}
