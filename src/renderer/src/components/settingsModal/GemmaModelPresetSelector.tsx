import React from "react";
import { useTranslation } from "react-i18next";
import { MODEL_PRESETS, type ModelPresetId } from "../settingsOptions";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import { GemmaMemorySummary } from "./GemmaMemorySummary";
import { confirmGemmaMemoryRisk } from "./gemmaMemoryRisk";
import { GemmaVramWarning } from "./GemmaVramWarning";

type ModelPresetFamily = "speed" | "legacy";

const MODEL_PRESET_FAMILY_IDS = ["speed", "legacy"] as const;
const MODEL_PRESET_BUTTON_IDS: Record<
  ModelPresetFamily,
  readonly ModelPresetId[]
> = {
  speed: ["qat12b", "qat26b", "qat31b", "custom"],
  legacy: ["minimum12b", "economy26b", "full31b", "custom"],
};
const MODEL_PRESET_FAMILY_BY_ID: Partial<
  Record<ModelPresetId, ModelPresetFamily>
> = {
  qat12b: "speed",
  qat26b: "speed",
  qat31b: "speed",
  minimum12b: "legacy",
  economy26b: "legacy",
  full31b: "legacy",
};
const MODEL_PRESET_COUNTERPARTS: Partial<Record<ModelPresetId, ModelPresetId>> =
  {
    qat12b: "minimum12b",
    minimum12b: "qat12b",
    qat26b: "economy26b",
    economy26b: "qat26b",
    qat31b: "full31b",
    full31b: "qat31b",
  };

type GemmaModelPresetSelectorProps = Pick<
  EngineSettingsPanelProps,
  | "clearTestState"
  | "allowUnsafeUnifiedMemory"
  | "controlsBusy"
  | "gpuMemoryMb"
  | "selectedPreset"
  | "setCustomVramMode"
  | "setAllowUnsafeUnifiedMemory"
  | "setSelectedPreset"
  | "unifiedMemoryMb"
  | "usesAppleHardware"
>;

export function GemmaModelPresetSelector(
  props: GemmaModelPresetSelectorProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const selectedFamily = MODEL_PRESET_FAMILY_BY_ID[props.selectedPreset];
  const [presetFamily, setPresetFamily] = React.useState<ModelPresetFamily>(
    () => selectedFamily ?? "speed",
  );

  React.useEffect(() => {
    if (selectedFamily) setPresetFamily(selectedFamily);
  }, [selectedFamily]);

  const selectPreset = (presetId: ModelPresetId): boolean => {
    if (!confirmGemmaMemoryRisk(presetId, props, t)) return false;
    props.clearTestState();
    props.setSelectedPreset(presetId);
    if (presetId !== "custom") {
      props.setCustomVramMode(MODEL_PRESETS[presetId].vramMode);
    }
    return true;
  };

  const selectPresetFamily = (family: ModelPresetFamily): void => {
    if (family === presetFamily) return;
    const counterpart = MODEL_PRESET_COUNTERPARTS[props.selectedPreset];
    if (counterpart && !selectPreset(counterpart)) return;
    setPresetFamily(family);
  };

  return (
    <>
      <ModelPresetFamilySelector
        controlsBusy={props.controlsBusy}
        presetFamily={presetFamily}
        selectPresetFamily={selectPresetFamily}
      />
      <div className="settings-field-stack">
        <span>{t("settings.gemma.preset.label")}</span>
        <div
          className="settings-preset-group"
          role="group"
          aria-label={t("settings.gemma.preset.ariaLabel")}
        >
          {MODEL_PRESET_BUTTON_IDS[presetFamily].map((presetId) => (
            <ModelPresetButton
              key={presetId}
              presetId={presetId}
              controlsBusy={props.controlsBusy}
              selectedPreset={props.selectedPreset}
              selectPreset={selectPreset}
            />
          ))}
        </div>
        <p className="muted-line modal-note">
          {props.selectedPreset === "custom"
            ? t("settings.gemma.preset.customDescription")
            : t(MODEL_PRESETS[props.selectedPreset].descriptionKey)}
        </p>
        {props.usesAppleHardware && props.selectedPreset !== "custom" ? (
          <GemmaMemorySummary
            allowUnsafeUnifiedMemory={props.allowUnsafeUnifiedMemory}
            selectedPreset={props.selectedPreset}
            unifiedMemoryMb={props.unifiedMemoryMb}
          />
        ) : null}
        {!props.usesAppleHardware && props.selectedPreset !== "custom" ? (
          <GemmaVramWarning
            gpuMemoryMb={props.gpuMemoryMb}
            selectedPreset={props.selectedPreset}
          />
        ) : null}
      </div>
    </>
  );
}

function ModelPresetFamilySelector({
  controlsBusy,
  presetFamily,
  selectPresetFamily,
}: {
  controlsBusy: boolean;
  presetFamily: ModelPresetFamily;
  selectPresetFamily: (family: ModelPresetFamily) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-field-stack">
      <span>{t("settings.gemma.preset.family.label")}</span>
      <div
        className="settings-mode-group"
        role="group"
        aria-label={t("settings.gemma.preset.family.ariaLabel")}
      >
        {MODEL_PRESET_FAMILY_IDS.map((family) => (
          <button
            key={family}
            type="button"
            className={`settings-preset-button ${presetFamily === family ? "active" : ""}`}
            onClick={() => selectPresetFamily(family)}
            disabled={controlsBusy}
            aria-pressed={presetFamily === family}
          >
            {t(`settings.gemma.preset.family.${family}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ModelPresetButton({
  presetId,
  controlsBusy,
  selectedPreset,
  selectPreset,
}: {
  presetId: ModelPresetId;
  controlsBusy: boolean;
  selectedPreset: ModelPresetId;
  selectPreset: (presetId: ModelPresetId) => boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <button
      type="button"
      className={`settings-preset-button ${selectedPreset === presetId ? "active" : ""}`}
      disabled={controlsBusy}
      aria-pressed={selectedPreset === presetId}
      onClick={() => selectPreset(presetId)}
    >
      {presetId === "custom"
        ? t("settings.gemma.preset.custom")
        : t(MODEL_PRESETS[presetId].labelKey)}
    </button>
  );
}
