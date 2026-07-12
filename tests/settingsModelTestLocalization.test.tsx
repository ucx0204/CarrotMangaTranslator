/** @vitest-environment jsdom */
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MangaApi } from "../src/shared/mangaApi";
import type { AppSettings } from "../src/shared/settingsTypes";
import { appI18n, initializeAppI18n } from "../src/renderer/src/appI18n";
import { useSettingsModelTest } from "../src/renderer/src/components/settingsModal/useSettingsModelTest";
import { AppI18nProvider } from "../src/renderer/src/i18n";

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await appI18n.changeLanguage("ko");
});

describe("settings model test localization", () => {
  it("keeps rejected bridge errors out of the visible result", async () => {
    const setTestState = vi.fn();
    const appendTestLogLine = vi.fn();
    const rawError = "raw bridge failure";
    window.mangaApi = {
      onUiLocaleChanged: () => () => undefined,
      onModelTestEvent: () => () => undefined,
      testModelSettings: vi.fn().mockRejectedValue(new Error(rawError)),
    } as unknown as MangaApi;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await initializeAppI18n("en");

    render(
      <AppI18nProvider>
        <ModelTestHarness
          appendTestLogLine={appendTestLogLine}
          setTestState={setTestState}
        />
      </AppI18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "run" }));

    await waitFor(() => {
      expect(setTestState).toHaveBeenLastCalledWith({
        status: "error",
        message:
          "An error occurred while requesting the Paddle OCR and translation engine check.",
        detail: null,
      });
    });
    expect(JSON.stringify(setTestState.mock.calls)).not.toContain(rawError);
  });
});

function ModelTestHarness({
  appendTestLogLine,
  setTestState,
}: {
  appendTestLogLine: (line: string) => void;
  setTestState: (state: unknown) => void;
}): React.JSX.Element {
  const run = useSettingsModelTest({
    appendTestLogLine,
    buildSettings: () => ({}) as AppSettings,
    canSubmit: true,
    jobActive: false,
    modelProvider: "gemma",
    setTestState,
  });
  return <button onClick={() => void run()}>run</button>;
}
