import React from "react";
import { useTranslation } from "react-i18next";
import { UI_LOCALE_OPTIONS, type UiLocale } from "../../../../shared/uiLocales";

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
    <div className="settings-field-stack">
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
      <p className="muted-line modal-note">
        {t("settings.general.languageDescription")}
      </p>
    </div>
  );
}
