import React from "react";
import { useTranslation } from "react-i18next";
import { SETTINGS_TABS, type SettingsTabId } from "../settingsModalTypes";
import { Tabs } from "../ui/Tabs";

type SettingsTabsProps = {
  activeTab: SettingsTabId;
  onChange: (tabId: SettingsTabId) => void;
};

export function SettingsTabs({
  activeTab,
  onChange,
}: SettingsTabsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const items = SETTINGS_TABS.map((tab) => ({
    value: tab.id,
    label: t(tab.labelKey),
    id: `settings-tab-${tab.id}`,
    panelId: `settings-panel-${tab.id}`,
  }));
  return (
    <Tabs
      className="settings-tabs"
      tabClassName="settings-tab"
      ariaLabel={t("settings.tabs.ariaLabel")}
      items={items}
      value={activeTab}
      onChange={onChange}
    />
  );
}
