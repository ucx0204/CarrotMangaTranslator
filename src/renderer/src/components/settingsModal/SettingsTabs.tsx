import React from "react";
import { useTranslation } from "react-i18next";
import { SETTINGS_TABS, type SettingsTabId } from "../settingsModalTypes";

type SettingsTabsProps = {
  activeTab: SettingsTabId;
  onChange: (tabId: SettingsTabId) => void;
};

export function SettingsTabs({
  activeTab,
  onChange,
}: SettingsTabsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <nav
      className="settings-tabs"
      role="tablist"
      aria-label={t("settings.tabs.ariaLabel")}
    >
      {SETTINGS_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`settings-tab-${tab.id}`}
          aria-selected={activeTab === tab.id}
          aria-controls={`settings-panel-${tab.id}`}
          className={`settings-tab ${activeTab === tab.id ? "active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </nav>
  );
}
