/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralSettingsPanel } from "../src/renderer/src/components/settingsModal/GeneralSettingsPanel";
import { appI18n } from "../src/renderer/src/appI18n";

afterEach(() => cleanup());

describe("GeneralSettingsPanel", () => {
  it("lists every supported language by its native name", () => {
    const onLocaleChange = vi.fn();
    render(
      <GeneralSettingsPanel
        locale="ko"
        disabled={false}
        onLocaleChange={onLocaleChange}
      />,
    );
    const select = screen.getByRole("combobox", { name: "앱 언어" });
    expect(
      [...(select as HTMLSelectElement).options].map((option) => option.text),
    ).toEqual(["한국어", "日本語", "English", "简体中文", "繁體中文"]);
    fireEvent.change(select, { target: { value: "zh-Hant" } });
    expect(onLocaleChange).toHaveBeenCalledWith("zh-Hant");
  });

  it("localizes the setting itself", async () => {
    await appI18n.changeLanguage("en");
    render(
      <GeneralSettingsPanel
        locale="en"
        disabled={false}
        onLocaleChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Application language" }),
    ).toBeTruthy();
  });
});
