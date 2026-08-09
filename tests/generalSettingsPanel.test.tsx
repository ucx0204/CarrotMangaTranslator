/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralSettingsPanel } from "../src/renderer/src/components/settingsModal/GeneralSettingsPanel";
import { appI18n } from "../src/renderer/src/appI18n";
import {
  chooseCustomSelectOption,
  customSelectOptionValues,
} from "./testUtils/customSelect";

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
    expect(customSelectOptionValues("앱 언어")).toEqual([
      "ko",
      "ja",
      "en",
      "zh-Hans",
      "zh-Hant",
    ]);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "앱 언어" }), {
      key: "Escape",
    });
    chooseCustomSelectOption("앱 언어", "繁體中文");
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
