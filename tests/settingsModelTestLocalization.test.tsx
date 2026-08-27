/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelTestProgressEvent,
  ModelTestResult,
} from "../src/shared/jobTypes";
import type { AppSettings } from "../src/shared/settingsTypes";
import { appI18n, initializeAppI18n } from "../src/renderer/src/appI18n";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useSettingsModelTest } from "../src/renderer/src/components/settingsModal/useSettingsModelTest";
import { AppI18nProvider } from "../src/renderer/src/i18n";
import { toast } from "../src/renderer/src/lib/toastStore";

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
    window.mangaApi = createTestMangaGatewayStub({
      onUiLocaleChanged: () => () => undefined,
      onModelTestEvent: () => () => undefined,
      testModelSettings: vi.fn().mockRejectedValue(new Error(rawError)),
    });
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

  it("unsubscribes and ignores a late result after unmount", async () => {
    let resolveRequest: ((value: ModelTestResult) => void) | undefined;
    const request = new Promise<ModelTestResult>((resolve) => {
      resolveRequest = resolve;
    });
    const unsubscribe = vi.fn();
    const setTestState = vi.fn();
    const appendTestLogLine = vi.fn();
    window.mangaApi = createTestMangaGatewayStub({
      onUiLocaleChanged: () => () => undefined,
      onModelTestEvent: () => unsubscribe,
      testModelSettings: vi.fn(() => request),
    });
    await initializeAppI18n("en");

    const view = render(
      <AppI18nProvider>
        <ModelTestHarness
          appendTestLogLine={appendTestLogLine}
          setTestState={setTestState}
        />
      </AppI18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "run" }));
    const callsBeforeUnmount = setTestState.mock.calls.length;
    view.unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
    await act(async () => {
      resolveRequest?.({
        ok: true,
        message: "late success",
        launchMode: "local",
      });
      await request;
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(setTestState).toHaveBeenCalledTimes(callsBeforeUnmount);
    expect(appendTestLogLine).not.toHaveBeenCalledWith("late success");
  });

  it("shows a runtime calibration notification without changing saved settings", async () => {
    let emit: ((event: ModelTestProgressEvent) => void) | undefined;
    let resolveRequest: ((value: ModelTestResult) => void) | undefined;
    const request = new Promise<ModelTestResult>((resolve) => {
      resolveRequest = resolve;
    });
    const testModelSettings = vi.fn(
      (settings: AppSettings, testId?: string) => {
        expect(settings).toBeDefined();
        expect(testId).toEqual(expect.any(String));
        return request;
      },
    );
    const info = vi.spyOn(toast, "info").mockReturnValue("toast-id");
    const setTestState = vi.fn();
    const appendTestLogLine = vi.fn();
    window.mangaApi = createTestMangaGatewayStub({
      onUiLocaleChanged: () => () => undefined,
      onModelTestEvent: (listener) => {
        emit = listener;
        return () => undefined;
      },
      testModelSettings,
    });
    await initializeAppI18n("ko");

    render(
      <AppI18nProvider>
        <ModelTestHarness
          appendTestLogLine={appendTestLogLine}
          setTestState={setTestState}
        />
      </AppI18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "run" }));

    await waitFor(() => expect(testModelSettings).toHaveBeenCalledOnce());
    const testId = testModelSettings.mock.calls[0]?.[1];
    expect(testId).toEqual(expect.any(String));
    act(() => {
      emit?.({
        id: testId ?? "",
        phase: "booting",
        progressText: "MTP fit 보정 중",
        notification: {
          variant: "info",
          message: "MTP fit 여유 VRAM을 실행 중에만 512 MiB 보정했습니다.",
        },
      });
    });

    expect(info).toHaveBeenCalledWith(
      "MTP fit 여유 VRAM을 실행 중에만 512 MiB 보정했습니다.",
    );
    await act(async () => {
      resolveRequest?.({
        ok: true,
        message: "ready",
        launchMode: "local",
      });
      await request;
    });
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
