import React from "react";
import { ControlTooltip } from "../ui/ControlTooltip";
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
import { Button } from "../ui/Button";

type FluxBackendSettingsProps = {
  clearTestState: () => void;
  controlsBusy: boolean;
  detectedGpuName?: string | null;
  fluxBackend: FluxBackend;
  inpaintingModel: InpaintingModel;
  isFluxBackendOptionDisabled: (backend: FluxBackend) => boolean;
  setFluxBackend: React.Dispatch<React.SetStateAction<FluxBackend>>;
  supportsFluxZluda?: boolean;
  usesAmdHardware: boolean;
  usesAppleHardware: boolean;
};

export function FluxBackendSettings({
  clearTestState,
  controlsBusy,
  detectedGpuName,
  fluxBackend,
  inpaintingModel,
  isFluxBackendOptionDisabled,
  setFluxBackend,
  supportsFluxZluda,
  usesAmdHardware,
  usesAppleHardware,
}: FluxBackendSettingsProps): React.JSX.Element {
  const { t } = useTranslation("components");
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
          <div className="settings-field-stack" key={option.id}>
            <ControlTooltip
              floating
              content={t(
                isFluxBackendOptionDisabled(option.id)
                  ? `settings.hardware.fluxRequirements.${option.id}`
                  : option.descriptionKey,
              )}
            >
              <button
                type="button"
                className={`settings-preset-button ${fluxBackend === option.id ? "active" : ""}`}
                onClick={() => {
                  clearTestState();
                  setFluxBackend(option.id);
                }}
                disabled={
                  controlsBusy || isFluxBackendOptionDisabled(option.id)
                }
                aria-pressed={fluxBackend === option.id}
              >
                {t(option.labelKey)}
              </button>
            </ControlTooltip>
          </div>
        ))}
      </div>
      <Sm75FluxWarning
        fluxBackend={fluxBackend}
        inpaintingModel={inpaintingModel}
      />
      <UnsupportedAmdFluxWarning
        clearTestState={clearTestState}
        controlsBusy={controlsBusy}
        detectedGpuName={detectedGpuName}
        fluxBackend={fluxBackend}
        inpaintingModel={inpaintingModel}
        setFluxBackend={setFluxBackend}
        supportsFluxZluda={supportsFluxZluda}
        usesAmdHardware={usesAmdHardware}
      />
      {inpaintingModel === "flux-klein" && fluxBackend === "zluda-native" ? (
        <AmdHipSdkDownloadButton />
      ) : null}
      <FluxHardwareContextNote usesAppleHardware={usesAppleHardware} />
    </div>
  );
}

function Sm75FluxWarning({
  fluxBackend,
  inpaintingModel,
}: Pick<
  FluxBackendSettingsProps,
  "fluxBackend" | "inpaintingModel"
>): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (
    inpaintingModel !== "flux-klein" ||
    fluxBackend !== "cuda-sm75-experimental"
  ) {
    return null;
  }
  return (
    <div className="hardware-runtime-warning" role="note">
      <strong>{t("settings.hardware.sm75FluxWarningTitle")}</strong>
      <span>{t("settings.hardware.sm75FluxWarningDetail")}</span>
    </div>
  );
}

function UnsupportedAmdFluxWarning({
  clearTestState,
  controlsBusy,
  detectedGpuName,
  fluxBackend,
  inpaintingModel,
  setFluxBackend,
  supportsFluxZluda,
  usesAmdHardware,
}: Pick<
  FluxBackendSettingsProps,
  | "clearTestState"
  | "controlsBusy"
  | "detectedGpuName"
  | "fluxBackend"
  | "inpaintingModel"
  | "setFluxBackend"
  | "supportsFluxZluda"
  | "usesAmdHardware"
>): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (
    inpaintingModel !== "flux-klein" ||
    !usesAmdHardware ||
    supportsFluxZluda !== false
  ) {
    return null;
  }
  return (
    <div className="hardware-runtime-warning" role="alert">
      <strong>{t("settings.hardware.fluxAmdUnsupportedTitle")}</strong>
      <span>
        {t("settings.hardware.fluxAmdUnsupportedDetail", {
          gpu: detectedGpuName || t("settings.hardware.detectedUnknown"),
        })}
      </span>
      {fluxBackend === "zluda-native" ? (
        <div className="hardware-runtime-warning-action">
          <Button
            size="sm"
            onClick={() => {
              clearTestState();
              setFluxBackend("cpu-native");
            }}
            disabled={controlsBusy}
          >
            {t("settings.hardware.fluxAmdUseCpu")}
          </Button>
        </div>
      ) : null}
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
