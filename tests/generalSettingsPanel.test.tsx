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
        wheelZoomSensitivityPercent={1}
        disabled={false}
        onLocaleChange={onLocaleChange}
        onWheelZoomSensitivityPercentChange={() => undefined}
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
        wheelZoomSensitivityPercent={1}
        disabled={false}
        onLocaleChange={() => undefined}
        onWheelZoomSensitivityPercentChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Application language" }),
    ).toBeTruthy();
  });

  it("uses a 1% to 10% wheel zoom slider", async () => {
    await appI18n.changeLanguage("ko");
    const onChange = vi.fn();
    render(
      <GeneralSettingsPanel
        locale="ko"
        wheelZoomSensitivityPercent={1}
        disabled={false}
        onLocaleChange={() => undefined}
        onWheelZoomSensitivityPercentChange={onChange}
      />,
    );
    const slider = screen.getByRole("slider", { name: "휠 줌 민감도" });
    expect(slider).toMatchObject({
      min: "1",
      max: "10",
      step: "1",
      value: "1",
    });
    fireEvent.change(slider, { target: { value: "10" } });
    expect(onChange).toHaveBeenCalledWith(10);
  });
});
