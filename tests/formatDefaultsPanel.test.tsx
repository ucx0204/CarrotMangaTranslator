/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";
import type { BlockFormatDefaults } from "../src/shared/settingsTypes";
import { FormatDefaultsPanel } from "../src/renderer/src/components/settingsModal/FormatDefaultsPanel";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { createBlockFontCatalog } from "../src/renderer/src/lib/fonts";
import { chooseCustomSelectOption } from "./testUtils/customSelect";

afterEach(cleanup);

describe("FormatDefaultsPanel", () => {
  it("uses the same preview and four always-visible editor sections", () => {
    const { container } = renderPanel();

    expect(container.querySelector(".gather-direct-preview")).toBeTruthy();
    expect(
      container.querySelectorAll(
        ".format-defaults-editor-controls > .gather-direct-editor-section",
      ),
    ).toHaveLength(4);
    expect(container.querySelector("details")).toBeNull();
    expect(screen.getByRole("slider", { name: "줄 간격" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "자간" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "장평" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "글자 투명도" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "안쪽 여백" })).toBeTruthy();
    expect(screen.getByText("12%")).toBeTruthy();
    expect(
      (
        screen.getByRole("combobox", {
          name: "줄바꿈 방식",
        }) as HTMLButtonElement
      ).value,
    ).toBe("break-word");
  });

  it("updates the live preview while keeping sample text out of settings", () => {
    const onChange = vi.fn();
    const { container } = renderPanel(onChange);

    fireEvent.change(screen.getByRole("textbox", { name: "예시 문구" }), {
      target: { value: "새 기본 서식 미리보기" },
    });
    expect(
      container.querySelector(".gather-direct-preview-text")?.textContent,
    ).toBe("새 기본 서식 미리보기");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "굵게" }));
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .fontWeight,
    ).toBe("700");
    expect(onChange).toHaveBeenLastCalledWith({ bold: true });
  });

  it("turns off auto fit when the size stepper is used", () => {
    const onChange = vi.fn();
    const { container } = renderPanel(onChange);

    fireEvent.click(screen.getByRole("button", { name: "글자 크기 늘리기" }));

    expect(onChange).toHaveBeenLastCalledWith({
      fontSizePx: 25,
      autoFitText: false,
    });
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .fontSize,
    ).toBe("25px");
  });

  it("accepts a directly typed default font size", () => {
    const onChange = vi.fn();
    const { container } = renderPanel(onChange);

    fireEvent.change(screen.getByRole("spinbutton", { name: "글자 크기" }), {
      target: { value: "50" },
    });

    expect(onChange).toHaveBeenLastCalledWith({
      fontSizePx: 50,
      autoFitText: false,
    });
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .fontSize,
    ).toBe("50px");
  });

  it("previews vertical direction and disabling the outline", () => {
    const onChange = vi.fn();
    const { container } = renderPanel(onChange);

    fireEvent.click(screen.getByRole("button", { name: "세로" }));
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .writingMode,
    ).toBe("vertical-rl");

    fireEvent.click(screen.getByRole("button", { name: "외곽선 사용" }));
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .textShadow,
    ).toBe("none");
    expect(onChange).toHaveBeenLastCalledWith({ outlineEnabled: false });
  });

  it("updates the default wrapping mode and its live preview", () => {
    const onChange = vi.fn();
    const { container } = renderPanel(onChange);

    chooseCustomSelectOption("줄바꿈 방식", "단어 단위");

    expect(onChange).toHaveBeenLastCalledWith({ wordBreak: "keep-all" });
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .wordBreak,
    ).toBe("keep-all");
    expect(
      screen.getByText("단어를 자르지 않고 단어 사이에서 줄을 바꿉니다."),
    ).toBeTruthy();
  });

  it("updates bubble-fit padding as a bounded percentage ratio", () => {
    const onPaddingChange = vi.fn();
    renderPanel(vi.fn(), onPaddingChange);
    const slider = screen.getByRole("slider", {
      name: "안쪽 여백",
    }) as HTMLInputElement;

    expect(slider.value).toBe("0.12");
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("0.7");
    expect(slider.step).toBe("0.01");

    fireEvent.change(slider, { target: { value: "0.7" } });

    expect(onPaddingChange).toHaveBeenLastCalledWith(0.7);
    expect(screen.getByText("70%")).toBeTruthy();
  });
});

function renderPanel(onChange = vi.fn(), onPaddingChange = vi.fn()) {
  return render(
    <FontsContext.Provider value={FONT_CONTEXT_VALUE}>
      <FormatDefaultsHarness
        onChange={onChange}
        onPaddingChange={onPaddingChange}
      />
    </FontsContext.Provider>,
  );
}

function FormatDefaultsHarness({
  onChange,
  onPaddingChange,
}: {
  onChange: (patch: Partial<BlockFormatDefaults>) => void;
  onPaddingChange: (value: number) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState<BlockFormatDefaults>({
    ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
    fontSizePx: 24,
  });
  const [paddingRatio, setPaddingRatio] = React.useState(0.12);
  return (
    <FormatDefaultsPanel
      bubbleLayoutPaddingRatio={paddingRatio}
      value={value}
      onBubbleLayoutPaddingRatioChange={(nextValue) => {
        onPaddingChange(nextValue);
        setPaddingRatio(nextValue);
      }}
      onChange={(patch) => {
        onChange(patch);
        setValue((current) => ({ ...current, ...patch }));
      }}
    />
  );
}

const FONT_CONTEXT_VALUE = {
  busy: false,
  catalog: createBlockFontCatalog([], {
    favoriteIds: [],
    orderedIds: [],
    defaultFontId: "nanum-gothic",
  }),
  baseOptions: [],
  options: [
    {
      id: "default",
      label: "기본 폰트",
      cssFamily: '"Nanum Gothic", sans-serif',
      sample: "가나다 Aa",
    },
    {
      id: "nanum-gothic",
      label: "나눔고딕",
      cssFamily: '"Nanum Gothic", sans-serif',
      sample: "나눔고딕 Aa",
    },
  ],
  registerFont: async () => undefined,
  removeFont: async () => undefined,
  savePreferences: async () => undefined,
};
