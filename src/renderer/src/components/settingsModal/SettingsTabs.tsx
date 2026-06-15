import React from "react";
import { SETTINGS_TABS, type SettingsTabId } from "../settingsModalTypes";

type SettingsTabsProps = {
  activeTab: SettingsTabId;
  onChange: (tabId: SettingsTabId) => void;
};

export function SettingsTabs({
  activeTab,
  onChange,
}: SettingsTabsProps): React.JSX.Element {
  return (
    <nav className="settings-tabs" role="tablist" aria-label="설정 영역">
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
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
