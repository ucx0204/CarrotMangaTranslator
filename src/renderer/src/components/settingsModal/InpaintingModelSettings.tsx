import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { InpaintingModel } from "../../../../shared/settingsTypes";
import { INPAINTING_MODEL_OPTIONS } from "../settingsOptions";
import { CheckboxField } from "../ui/CheckboxField";

export type InpaintingModelSettingsProps = {
  allowUnsafeLowMemoryFlux: boolean;
  clearTestState: () => void;
  controlsBusy: boolean;
  inpaintingModel: InpaintingModel;
  setAllowUnsafeLowMemoryFlux: React.Dispatch<React.SetStateAction<boolean>>;
  setInpaintingModel: React.Dispatch<React.SetStateAction<InpaintingModel>>;
  unifiedMemoryMb: number | null;
  usesAppleHardware: boolean;
};

export function InpaintingModelSettings(
  props: InpaintingModelSettingsProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const active = INPAINTING_MODEL_OPTIONS.find(
    (option) => option.id === props.inpaintingModel,
  );
  return (
    <div className="settings-field-stack">
      <span>{t("settings.hardware.inpaintingModel")}</span>
      <div
        className="settings-preset-group"
        role="group"
        aria-label={t("settings.hardware.inpaintingModel")}
      >
        {INPAINTING_MODEL_OPTIONS.map((option) => (
          <InpaintingModelButton key={option.id} option={option} {...props} />
        ))}
      </div>
      <p className="muted-line modal-note">
        {active ? t(active.descriptionKey) : null}
      </p>
      <FluxMemoryWarning {...props} />
    </div>
  );
}

function InpaintingModelButton({
  allowUnsafeLowMemoryFlux,
  clearTestState,
  controlsBusy,
  inpaintingModel,
  option,
  setAllowUnsafeLowMemoryFlux,
  setInpaintingModel,
  unifiedMemoryMb,
  usesAppleHardware,
}: InpaintingModelSettingsProps & {
  option: (typeof INPAINTING_MODEL_OPTIONS)[number];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <button
      type="button"
      className={`settings-preset-button ${inpaintingModel === option.id ? "active" : ""}`}
      disabled={controlsBusy}
      aria-pressed={inpaintingModel === option.id}
      onClick={() => {
        if (
          option.id === "flux-klein" &&
          needsFluxOverride(usesAppleHardware, unifiedMemoryMb) &&
          !allowUnsafeLowMemoryFlux
        ) {
          if (!confirmFluxRisk(t, unifiedMemoryMb)) return;
          setAllowUnsafeLowMemoryFlux(true);
        } else if (option.id !== "flux-klein") {
          setAllowUnsafeLowMemoryFlux(false);
        }
        clearTestState();
        setInpaintingModel(option.id);
      }}
    >
      {t(option.labelKey)}
    </button>
  );
}

function FluxMemoryWarning(
  props: InpaintingModelSettingsProps,
): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (
    props.inpaintingModel !== "flux-klein" ||
    !needsFluxOverride(props.usesAppleHardware, props.unifiedMemoryMb)
  ) {
    return null;
  }
  return (
    <CheckboxField
      className="inline-toggle mac-alpha-memory-warning"
      checked={props.allowUnsafeLowMemoryFlux}
      label={t("settings.hardware.fluxLowMemoryOverride", {
        available: formatMemoryGb(props.unifiedMemoryMb ?? 0),
      })}
      onCheckedChange={(checked) => {
        if (checked && !confirmFluxRisk(t, props.unifiedMemoryMb)) return;
        props.setAllowUnsafeLowMemoryFlux(checked);
      }}
    />
  );
}

function needsFluxOverride(
  usesAppleHardware: boolean,
  unifiedMemoryMb: number | null,
): boolean {
  return usesAppleHardware && (unifiedMemoryMb ?? 0) < 16 * 1024;
}

function confirmFluxRisk(
  t: TFunction<"components">,
  unifiedMemoryMb: number | null,
): boolean {
  return window.confirm(
    t("settings.hardware.fluxLowMemoryConfirm", {
      available: formatMemoryGb(unifiedMemoryMb ?? 0),
    }),
  );
}

function formatMemoryGb(memoryMb: number): string {
  return `${Math.round((memoryMb / 1024) * 10) / 10} GB`;
}
