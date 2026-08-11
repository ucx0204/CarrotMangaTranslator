/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import exampleSettings from "../settings.example.json";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { appI18n, initializeAppI18n } from "../src/renderer/src/appI18n";
import { ToastViewport } from "../src/renderer/src/components/ui/ToastViewport";
import { useSettingsDialog } from "../src/renderer/src/hooks/useSettingsDialog";
import { dismissToast, getToasts } from "../src/renderer/src/lib/toastStore";
import type { AppSettings } from "../src/shared/settingsTypes";

const initialSettings = structuredClone(exampleSettings) as AppSettings;

afterEach(async () => {
  cleanup();
  for (const item of getToasts()) dismissToast(item.id);
  vi.clearAllMocks();
  await appI18n.changeLanguage("ko");
});

describe("settings dialog save flow", () => {
  it("keeps the dialog open and shows a success toast after saving", async () => {
    const saveSettings = vi.fn(async (settings: AppSettings) =>
      structuredClone(settings),
    );
    window.mangaApi = createTestMangaGatewayStub({
      getSettings: vi.fn(async () => structuredClone(initialSettings)),
      saveSettings,
    });
    await initializeAppI18n("ko");
    const pushStatus = vi.fn();

    render(
      <I18nextProvider i18n={appI18n}>
        <SettingsDialogHarness pushStatus={pushStatus} />
        <ToastViewport />
      </I18nextProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("settings-ready").textContent).toBe("ready"),
    );
    fireEvent.click(screen.getByRole("button", { name: "open settings" }));
    expect(screen.getByTestId("settings-open").textContent).toBe("open");

    fireEvent.click(screen.getByRole("button", { name: "save settings" }));

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("settings-busy").textContent).toBe("idle"),
    );
    expect(screen.getByTestId("settings-open").textContent).toBe("open");

    const statusMessage = appI18n.t("settings.saved", { ns: "renderer" });
    const toastMessage = appI18n.t("settings.savedToast", { ns: "renderer" });
    expect(pushStatus).toHaveBeenCalledWith(statusMessage);
    const toastRegion = screen.getByRole("region", { name: "알림" });
    expect(within(toastRegion).getByRole("status").textContent).toContain(
      toastMessage,
    );
    expect(getToasts()[0]).toMatchObject({
      message: toastMessage,
      variant: "success",
    });

    fireEvent.click(screen.getByRole("button", { name: "close settings" }));
    expect(screen.getByTestId("settings-open").textContent).toBe("closed");
  });
});

function SettingsDialogHarness({
  pushStatus,
}: {
  pushStatus: (message: string) => void;
}): React.JSX.Element {
  const dialog = useSettingsDialog(pushStatus);
  return (
    <>
      <button type="button" onClick={() => void dialog.openSettings()}>
        open settings
      </button>
      <button
        type="button"
        disabled={!dialog.settings}
        onClick={() => {
          if (dialog.settings) void dialog.submitSettings(dialog.settings);
        }}
      >
        save settings
      </button>
      <button type="button" onClick={dialog.closeSettings}>
        close settings
      </button>
      <output data-testid="settings-ready">
        {dialog.settings ? "ready" : "loading"}
      </output>
      <output data-testid="settings-open">
        {dialog.settingsOpen ? "open" : "closed"}
      </output>
      <output data-testid="settings-busy">
        {dialog.settingsBusy ? "busy" : "idle"}
      </output>
    </>
  );
}
