export type SettingsTabId = "engine" | "hardware" | "test";

export const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: "engine", label: "번역 엔진" },
  { id: "hardware", label: "하드웨어 · OCR" },
  { id: "test", label: "설치 / 확인" },
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
