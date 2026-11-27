import type { IntelGpuSupport } from "../../../../shared/intelHardware";
import { SegmentedControl } from "../ui/SegmentedControl";
import React from "react";
import { ControlTooltip } from "../ui/ControlTooltip";
import { useTranslation } from "react-i18next";
import type {
  FluxBackend,
  InpaintingModel,
} from "../../../../shared/settingsTypes";
import { FLUX_BACKEND_OPTIONS } from "../settingsOptions";
import { FluxHardwareContextNote } from "./HardwareContextNotes";
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
  supportsQwenRocm?: boolean;
  intel?: IntelGpuSupport;
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
              <Button
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
                variant="bare"
              >
                {t(option.labelKey)}
              </Button>
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
    supportsFluxZluda !== false ||
    fluxBackend === "vulkan-native"
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
      {fluxBackend === "rocm-native" ? (
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

export function QwenBackendSettings({
  usesAppleHardware,
  usesAmdHardware,
  intel,
  fluxBackend,
  supportsQwenRocm,
  setFluxBackend,
  clearTestState,
  controlsBusy,
}: Pick<
  FluxBackendSettingsProps,
  | "usesAppleHardware"
  | "intel"
  | "usesAmdHardware"
  | "fluxBackend"
  | "supportsQwenRocm"
  | "setFluxBackend"
  | "clearTestState"
  | "controlsBusy"
>) {
  const { t } = useTranslation("components");
  const backends = usesAppleHardware
    ? ["metal-native"]
    : intel
      ? ["vulkan-native"]
      : usesAmdHardware
        ? ["rocm-native", "vulkan-native"]
        : ["cuda-native", "vulkan-native"];
  const options = FLUX_BACKEND_OPTIONS.filter((option) =>
    backends.includes(option.id),
  ).map((option) => ({
    id: option.id,
    label: t(option.labelKey),
    disabled: option.id === "rocm-native" && supportsQwenRocm === false,
  }));
  const current = backends.includes(fluxBackend)
    ? fluxBackend
    : usesAmdHardware && !supportsQwenRocm
      ? "vulkan-native"
      : options[0].id;
  return (
    <div className="settings-field-stack">
      <span>{t("settings.hardware.qwenBackend")}</span>
      <SegmentedControl
        ariaLabel={t("settings.hardware.qwenBackend")}
        options={options}
        value={current}
        disabled={controlsBusy}
        onChange={(backend) => {
          clearTestState();
          setFluxBackend(backend);
        }}
      />
    </div>
  );
}
