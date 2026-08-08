import React from "react";
import { useTranslation } from "react-i18next";
import type {
  FluxBackend,
  InpaintingModel,
} from "../../../../shared/settingsTypes";
import { FLUX_BACKEND_OPTIONS } from "../settingsOptions";
import {
  AmdHipSdkDownloadButton,
  FluxHardwareContextNote,
} from "./HardwareContextNotes";

type FluxBackendSettingsProps = {
  clearTestState: () => void;
  controlsBusy: boolean;
  fluxBackend: FluxBackend;
  inpaintingModel: InpaintingModel;
  isFluxBackendOptionDisabled: (backend: FluxBackend) => boolean;
  setFluxBackend: React.Dispatch<React.SetStateAction<FluxBackend>>;
  usesAmdHardware: boolean;
  usesAppleHardware: boolean;
  usesNvidiaHardware: boolean;
};

export function FluxBackendSettings({
  clearTestState,
  controlsBusy,
  fluxBackend,
  inpaintingModel,
  isFluxBackendOptionDisabled,
  setFluxBackend,
  usesAmdHardware,
  usesAppleHardware,
  usesNvidiaHardware,
}: FluxBackendSettingsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const activeFluxBackend = FLUX_BACKEND_OPTIONS.find(
    (option) => option.id === fluxBackend,
  );
  const visibleFluxBackends = resolveVisibleFluxBackends(usesAppleHardware);
  return (
    <div className="settings-field-stack">
      <span>{t("settings.hardware.fluxBackend")}</span>
      <div
        className="settings-preset-group"
        role="group"
        aria-label={t("settings.hardware.fluxBackend")}
      >
        {visibleFluxBackends.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${fluxBackend === option.id ? "active" : ""}`}
            onClick={() => {
              clearTestState();
              setFluxBackend(option.id);
            }}
            disabled={controlsBusy || isFluxBackendOptionDisabled(option.id)}
            aria-pressed={fluxBackend === option.id}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>
      {fluxBackend === "cuda-sm75-experimental" &&
      inpaintingModel === "flux-klein" ? null : (
        <p className="muted-line modal-note">
          {inpaintingModel === "flux-klein"
            ? activeFluxBackend
              ? t(activeFluxBackend.descriptionKey)
              : null
            : t("settings.hardware.fluxOnlyNote")}
        </p>
      )}
      {inpaintingModel === "flux-klein" &&
      fluxBackend === "cuda-sm75-experimental" ? (
        <div className="sm75-flux-warning" role="note">
          <strong>{t("settings.hardware.sm75FluxWarningTitle")}</strong>
          <span>{t("settings.hardware.sm75FluxWarningDetail")}</span>
        </div>
      ) : null}
      {inpaintingModel === "flux-klein" && fluxBackend === "zluda-native" ? (
        <AmdHipSdkDownloadButton />
      ) : null}
      <FluxHardwareContextNote
        usesAmdHardware={usesAmdHardware}
        usesAppleHardware={usesAppleHardware}
        usesNvidiaHardware={usesNvidiaHardware}
      />
    </div>
  );
}

function resolveVisibleFluxBackends(
  usesAppleHardware: boolean,
): typeof FLUX_BACKEND_OPTIONS {
  return FLUX_BACKEND_OPTIONS.filter((option) => {
    if (usesAppleHardware) return option.id === "metal-native";
    return option.id !== "metal-native";
  });
}
