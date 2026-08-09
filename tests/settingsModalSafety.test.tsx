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
import { afterEach, describe, expect, it, vi } from "vitest";
import exampleSettings from "../settings.example.json";
import { SettingsModal } from "../src/renderer/src/components/SettingsModal";
import type { AppSettings } from "../src/shared/settingsTypes";

const initialSettings = structuredClone(exampleSettings) as AppSettings;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("settings draft safety", () => {
  it("disables Save until the draft changes and protects dirty close", () => {
    const onCancel = vi.fn();
    renderSettings({ onCancel });

    const save = screen.getByRole("button", { name: "저장" });
    expect(save).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByRole("combobox", { name: "앱 언어" }), {
      target: { value: "en" },
    });
    expect(save).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onCancel).not.toHaveBeenCalled();
    const confirmDialog = screen.getAllByRole("dialog").at(-1);
    if (!confirmDialog) throw new Error("discard confirmation not found");
    expect(
      within(confirmDialog).getByText("변경한 설정을 버리고 닫을까요?"),
    ).toBeTruthy();
    fireEvent.click(
      within(confirmDialog).getByRole("button", {
        name: "변경 사항 버리기",
      }),
    );
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("loads defaults into the draft without applying them until Save", async () => {
    const onSubmit = vi.fn();
    const defaultSettings = {
      ...structuredClone(initialSettings),
      ui: { ...initialSettings.ui, locale: "en" as const },
    };
    const onReset = vi.fn(() => Promise.resolve(defaultSettings));
    renderSettings({ onReset, onSubmit });

    fireEvent.click(screen.getByRole("button", { name: "기본값 복원" }));

    expect(onReset).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      await screen.findByText("기본값을 임시로 불러왔습니다"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "앱 언어" })).toHaveProperty(
        "value",
        "en",
      ),
    );

    const save = screen.getByRole("button", { name: "저장" });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        ui: expect.objectContaining({ locale: "en" }),
      }),
    );
  });
});

function renderSettings({
  onCancel = vi.fn(),
  onReset = vi.fn(() => Promise.resolve(initialSettings)),
  onSubmit = vi.fn(),
}: {
  onCancel?: () => void;
  onReset?: () => Promise<AppSettings | null>;
  onSubmit?: (settings: AppSettings) => void;
} = {}): void {
  render(
    <SettingsModal
      initialSettings={initialSettings}
      busy={false}
      jobActive={false}
      onCancel={onCancel}
      onOpenLogFolder={() => undefined}
      onReset={onReset}
      onSubmit={onSubmit}
    />,
  );
}
