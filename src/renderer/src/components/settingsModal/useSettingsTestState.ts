import React from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../../shared/settingsTypes";
import type { TestState } from "../settingsModalTypes";

export type SettingsTestStateController = {
  testState: TestState;
  testLogLines: string[];
  testLogRef: React.RefObject<HTMLDivElement | null>;
  setTestState: React.Dispatch<React.SetStateAction<TestState>>;
  clearTestState: () => void;
  appendTestLogLine: (line: string) => void;
};

const IDLE_TEST_STATE: TestState = {
  status: "idle",
  message: null,
  detail: null,
};

export function useSettingsTestState(
  initialSettings: AppSettings,
  testLogRef: React.RefObject<HTMLDivElement | null>,
): SettingsTestStateController {
  const { i18n } = useTranslation("components");
  const [testState, setTestState] = React.useState<TestState>(IDLE_TEST_STATE);
  const [testLogLines, setTestLogLines] = React.useState<string[]>([]);

  React.useEffect(() => {
    setTestState(IDLE_TEST_STATE);
    setTestLogLines([]);
  }, [i18n.resolvedLanguage, initialSettings]);

  React.useEffect(() => {
    if (!testLogRef.current) {
      return;
    }
    testLogRef.current.scrollTop = testLogRef.current.scrollHeight;
  }, [testLogLines, testLogRef]);

  const clearTestState = React.useCallback(() => {
    setTestState(IDLE_TEST_STATE);
    setTestLogLines([]);
  }, []);

  const appendTestLogLine = React.useCallback((line: string) => {
    const normalized = line.trim();
    if (!normalized) {
      return;
    }
    setTestLogLines((current) => {
      if (current[current.length - 1] === normalized) {
        return current;
      }
      return [...current, normalized].slice(-180);
    });
  }, []);

  return {
    testState,
    testLogLines,
    testLogRef,
    setTestState,
    clearTestState,
    appendTestLogLine,
  };
}
