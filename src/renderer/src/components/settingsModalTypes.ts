export type SettingsTabId =
  | "general"
  | "engine"
  | "hardware"
  | "format"
  | "shortcuts"
  | "test";

export const SETTINGS_TABS: { id: SettingsTabId; labelKey: string }[] = [
  { id: "general", labelKey: "settings.tabs.general" },
  { id: "engine", labelKey: "settings.tabs.engine" },
  { id: "hardware", labelKey: "settings.tabs.hardware" },
  { id: "format", labelKey: "settings.tabs.format" },
  { id: "shortcuts", labelKey: "settings.tabs.shortcuts" },
  { id: "test", labelKey: "settings.tabs.test" },
];

export type TestState =
  | {
      status: "idle";
      message: null;
      detail: null;
    }
  | {
      status: "running" | "success" | "error";
      message: string;
      detail: string | null;
    };
