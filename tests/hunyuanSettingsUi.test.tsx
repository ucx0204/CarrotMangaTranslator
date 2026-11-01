/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OcrRecommendation } from "../src/renderer/src/components/OcrRecommendation";
import { HunyuanSettingsFields } from "../src/renderer/src/components/settingsModal/HunyuanSettingsFields";
import { OCR_PIPELINES } from "../src/shared/ocrEngines";
import type { HunyuanSettings } from "../src/shared/settingsTypes";

afterEach(cleanup);

it("hides an already-applied recommendation and locates read-only recommendations in settings", () => {
  const view = render(
    <OcrRecommendation pipeline="hayai" sourceLanguage="ja" />,
  );
  expect(view.container.textContent).toBe("");
  view.rerender(<OcrRecommendation pipeline="hayai" sourceLanguage="zh" />);
  expect(screen.getByText(/설정/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

it("keeps Hunyuan second and applies recommendations only on request", () => {
  expect(OCR_PIPELINES).toEqual(["hayai", "hunyuan", "paddle-legacy"]);
  const apply = vi.fn();
  const { rerender } = render(
    <OcrRecommendation pipeline="hayai" sourceLanguage="zh" onApply={apply} />,
  );
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "추천 적용" }));
  expect(apply).toHaveBeenCalledWith("hunyuan");
  rerender(
    <OcrRecommendation
      pipeline="hunyuan"
      sourceLanguage="ja"
      onApply={apply}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "추천 적용" }));
  expect(apply).toHaveBeenLastCalledWith("hayai");
  rerender(
    <OcrRecommendation
      pipeline="hunyuan"
      sourceLanguage="auto"
      onApply={apply}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText(/일본어는 Hayai/)).toBeTruthy();
});

it("defaults to F16 and lets users change Q4 and CPU independently", () => {
  function Harness() {
    const [value, setValue] = React.useState<HunyuanSettings>({
      model: "f16",
      device: "auto",
    });
    return (
      <HunyuanSettingsFields
        value={value}
        onChange={setValue}
        disabled={false}
      />
    );
  }
  render(<Harness />);
  expect(
    screen.getByRole("radio", { name: "F16" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.queryByText(/Q5/)).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Q4_K_M" }));
  fireEvent.click(screen.getByRole("radio", { name: "CPU" }));
  expect(
    screen.getByRole("radio", { name: "Q4_K_M" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByRole("radio", { name: "CPU" }).getAttribute("aria-checked"),
  ).toBe("true");
});

it("prevents edits while settings are busy", () => {
  const change = vi.fn();
  render(<HunyuanSettingsFields onChange={change} disabled />);
  fireEvent.click(screen.getByRole("radio", { name: "Q4_K_M" }));
  expect(change).not.toHaveBeenCalled();
});
