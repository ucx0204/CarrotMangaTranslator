import React from "react";
import { useTranslation } from "react-i18next";
import { settingsGateway } from "./settingsGateway";

export function OcrHardwareContextNote({
  usesAmdOcrContext,
  usesAppleHardware,
  usesNvidiaOcrContext,
}: {
  usesAmdOcrContext: boolean;
  usesAppleHardware: boolean;
  usesNvidiaOcrContext: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (usesAppleHardware) {
    return (
      <p className="muted-line modal-note">
        {t("settings.hardware.ocrAppleNote")}
      </p>
    );
  }
  if (usesAmdOcrContext) {
    return (
      <p className="muted-line modal-note">
        {t("settings.hardware.ocrAmdNote")}
      </p>
    );
  }
  if (usesNvidiaOcrContext) {
    return (
      <p className="muted-line modal-note">
        {t("settings.hardware.ocrNvidiaNote")}
      </p>
    );
  }
  return null;
}

export function FluxHardwareContextNote({
  usesAmdHardware,
  usesAppleHardware,
  usesNvidiaHardware,
}: {
  usesAmdHardware: boolean;
  usesAppleHardware: boolean;
  usesNvidiaHardware: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (usesAppleHardware) {
    return (
      <p className="muted-line modal-note">
        {t("settings.hardware.fluxAppleNote")}
      </p>
    );
  }
  if (usesAmdHardware) {
    return (
      <p className="muted-line modal-note">
        {t("settings.hardware.fluxAmdNote")}
      </p>
    );
  }
  if (usesNvidiaHardware) {
    return (
      <p className="muted-line modal-note">
        {t("settings.hardware.fluxNvidiaNote")}
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
          console.error("Failed to open AMD HIP SDK download page", error);
        });
      }}
    >
      {t("settings.hardware.downloadHipSdk")}
    </button>
  );
}
