import React from "react";
import { useTranslation } from "react-i18next";
import { UI_LOCALE_OPTIONS, type UiLocale } from "../../../../shared/uiLocales";
import { SettingsSection } from "./SettingsSection";
import { Select } from "../ui/Select";

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
    </div>
  );
}
