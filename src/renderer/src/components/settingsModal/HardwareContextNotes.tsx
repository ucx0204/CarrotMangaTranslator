import React from "react";
import { useTranslation } from "react-i18next";
import { settingsGateway } from "../../api/settingsGateway";
import { toast } from "../../lib/toastStore";
import { formatSettingsErrorMessage } from "../settingsModalHelpers";

export function FluxHardwareContextNote({
  usesAppleHardware,
}: {
  usesAppleHardware: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (usesAppleHardware) {
    return (
      <p className="muted-line modal-note">
        {t("settings.hardware.fluxAppleNote")}
      </p>
    );
  }
  return null;
}

export function AmdHipSdkDownloadButton(): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <button
      type="button"
      className="settings-external-link"
      onClick={() => {
        void settingsGateway.openAmdHipSdkDownload().catch((error) => {
          toast.error(
            formatSettingsErrorMessage(
              error,
              t("settings.hardware.openLinkFailed"),
            ),
          );
        });
      }}
    >
      {t("settings.hardware.downloadHipSdk")}
    </button>
  );
}
