import React from "react";
import { useTranslation } from "react-i18next";
import { UI_LOCALE_OPTIONS, type UiLocale } from "../../../../shared/uiLocales";
import { SettingsSection } from "./SettingsSection";

export type GeneralSettingsPanelProps = {
  locale: UiLocale;
  disabled: boolean;
  onLocaleChange: (locale: UiLocale) => void;
};

export function GeneralSettingsPanel({
  locale,
  disabled,
  onLocaleChange,
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
          <select
            value={locale}
            disabled={disabled}
            onChange={(event) => onLocaleChange(event.target.value as UiLocale)}
          >
            {UI_LOCALE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.nativeName}
              </option>
            ))}
          </select>
        </label>
      </SettingsSection>
    </div>
  );
}
