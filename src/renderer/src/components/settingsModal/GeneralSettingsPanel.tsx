import React from "react";
import { useTranslation } from "react-i18next";
import { UI_LOCALE_OPTIONS, type UiLocale } from "../../../../shared/uiLocales";
import {
  MAX_WHEEL_ZOOM_SENSITIVITY_PERCENT,
  MIN_WHEEL_ZOOM_SENSITIVITY_PERCENT,
  type WheelZoomSensitivityPercent,
} from "../../../../shared/settingsTypes";
import { SettingsSection } from "./SettingsSection";
import { Select } from "../ui/Select";
import { FieldSlider } from "../ui/FieldSlider";

export type GeneralSettingsPanelProps = {
  locale: UiLocale;
  wheelZoomSensitivityPercent: WheelZoomSensitivityPercent;
  disabled: boolean;
  onLocaleChange: (locale: UiLocale) => void;
  onWheelZoomSensitivityPercentChange: (
    value: WheelZoomSensitivityPercent,
  ) => void;
};

export function GeneralSettingsPanel({
  locale,
  wheelZoomSensitivityPercent,
  disabled,
  onLocaleChange,
  onWheelZoomSensitivityPercentChange,
}: GeneralSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-panel-stack">
      <SettingsSection
        title={t("settings.general.language")}
        description={t("settings.general.languageDescription")}
      >
        <label>
          {t("settings.general.language")}
          <Select
            ariaLabel={t("settings.general.language")}
            value={locale}
            disabled={disabled}
            options={UI_LOCALE_OPTIONS.map((option) => ({
              value: option.id,
              label: option.nativeName,
            }))}
            onValueChange={(nextValue) => onLocaleChange(nextValue as UiLocale)}
          />
        </label>
      </SettingsSection>
      <SettingsSection
        title={t("settings.general.wheelZoom.title")}
        description={t("settings.general.wheelZoom.description")}
      >
        <FieldSlider
          label={t("settings.general.wheelZoom.label")}
          valueLabel={`${wheelZoomSensitivityPercent}%`}
          min={MIN_WHEEL_ZOOM_SENSITIVITY_PERCENT}
          max={MAX_WHEEL_ZOOM_SENSITIVITY_PERCENT}
          step={1}
          value={wheelZoomSensitivityPercent}
          disabled={disabled}
          onChange={(event) =>
            onWheelZoomSensitivityPercentChange(
              Number(event.target.value) as WheelZoomSensitivityPercent,
            )
          }
        />
      </SettingsSection>
    </div>
  );
}
