/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";
import type { BlockFormatDefaults } from "../src/shared/settingsTypes";
import { FormatDefaultsPanel } from "../src/renderer/src/components/settingsModal/FormatDefaultsPanel";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { createBlockFontCatalog } from "../src/renderer/src/lib/fonts";
import { chooseCustomSelectOption } from "./testUtils/customSelect";
import {
  createBlockStylePresetFromDefaults,
  type BlockStylePreset,
} from "../src/shared/blockStylePresets";
import { dismissToast, getToasts } from "../src/renderer/src/lib/toastStore";

afterEach(() => {
  cleanup();
  getToasts().forEach((item) => dismissToast(item.id));
});

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
    expect(screen.getByRole("spinbutton", { name: "줄 간격" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "자간" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "장평" })).toBeTruthy();
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

  it("shows font previews, favorite actions, and font management", () => {
    renderPanel();

    expect(screen.getByRole("button", { name: "폰트 관리" })).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "글꼴" }));

    const option = screen.getByRole("option", { name: "나눔고딕" });
    expect(option.textContent).toContain("나눔고딕 Aa");
    expect(
      within(option).getByRole("button", {
        name: "나눔고딕 즐겨찾기에 추가",
      }),
    ).toBeTruthy();
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

    chooseCustomSelectOption("글꼴", "나눔고딕");
    expect(onChange).toHaveBeenLastCalledWith({ fontFamily: "nanum-gothic" });

    fireEvent.click(screen.getByRole("button", { name: "굵게" }));
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .fontWeight,
    ).toBe("700");
    expect(onChange).toHaveBeenLastCalledWith({ bold: true });
  });

  it("changes the manual default size without exposing run-level auto fit", () => {
    const onChange = vi.fn();
    const { container } = renderPanel(onChange);

    fireEvent.click(screen.getByRole("button", { name: "글자 크기 늘리기" }));

    expect(onChange).toHaveBeenLastCalledWith({ fontSizePx: 24.5 });
    expect(screen.queryByRole("button", { name: "켜짐" })).toBeNull();
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .fontSize,
    ).toBe("24.5px");

    fireEvent.click(screen.getByRole("button", { name: "글자 크기 줄이기" }));
    expect(onChange).toHaveBeenLastCalledWith({ fontSizePx: 24 });
  });

  it("accepts a directly typed default font size", () => {
    const onChange = vi.fn();
    const { container } = renderPanel(onChange);

    const input = screen.getByRole("spinbutton", { name: "글자 크기" });
    fireEvent.change(input, {
      target: { value: "50" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenLastCalledWith({ fontSizePx: 50 });
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .fontSize,
    ).toBe("50px");
  });

  it("accepts expanded spacing and width values through direct inputs", () => {
    const onChange = vi.fn();
    renderPanel(onChange);
    const lineHeight = screen.getByRole("spinbutton", {
      name: "줄 간격",
    }) as HTMLInputElement;
    const letterSpacing = screen.getByRole("spinbutton", {
      name: "자간",
    }) as HTMLInputElement;
    const fontWidth = screen.getByRole("spinbutton", {
      name: "장평",
    }) as HTMLInputElement;

    expect([lineHeight.min, lineHeight.max, lineHeight.step]).toEqual([
      "0.1",
      "10",
      "0.01",
    ]);
    expect([letterSpacing.min, letterSpacing.max, letterSpacing.step]).toEqual([
      "-1",
      "5",
      "0.01",
    ]);
    expect([fontWidth.min, fontWidth.max, fontWidth.step]).toEqual([
      "10",
      "500",
      "1",
    ]);

    fireEvent.change(lineHeight, { target: { value: "10" } });
    fireEvent.keyDown(lineHeight, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith({ lineHeight: 10 });

    fireEvent.change(letterSpacing, { target: { value: "-1" } });
    fireEvent.blur(letterSpacing);
    expect(onChange).toHaveBeenLastCalledWith({ letterSpacing: -1 });

    fireEvent.change(fontWidth, { target: { value: "500" } });
    fireEvent.keyDown(fontWidth, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith({ fontWidthScale: 5 });
  });

  it("previews vertical direction and disabling the outline", () => {
    const onChange = vi.fn();
    const { container } = renderPanel(onChange);

    fireEvent.click(screen.getByRole("button", { name: "왼쪽 정렬" }));
    expect(onChange).toHaveBeenLastCalledWith({ textAlign: "left" });

    fireEvent.click(screen.getByRole("button", { name: "세로" }));
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .writingMode,
    ).toBe("vertical-rl");

    fireEvent.click(screen.getByRole("checkbox", { name: "외곽선 사용" }));
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .textShadow,
    ).toBe("none");
    expect(onChange).toHaveBeenLastCalledWith({ outlineEnabled: false });
  });

  it("edits outline width in 0.5px steps and restores it after toggling", () => {
    const onChange = vi.fn();
    const { container } = renderPanel(onChange);
    const input = screen.getByRole("spinbutton", {
      name: "외곽선 굵기",
    });

    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({ outlineWidthPx: 8 });
    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .webkitTextStrokeWidth,
    ).toBe("16px");

    const checkbox = screen.getByRole("checkbox", { name: "외곽선 사용" });
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenLastCalledWith({ outlineEnabled: false });
    expect((input as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenLastCalledWith({ outlineEnabled: true });
    expect((input as HTMLInputElement).valueAsNumber).toBe(8);
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
      container.querySelector(".text-wrapping-select-description"),
    ).toBeNull();
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

  it("edits a selected preset in the same controls without mutating defaults", () => {
    const onDefaultChange = vi.fn();
    render(
      <FontsContext.Provider value={FONT_CONTEXT_VALUE}>
        <FormatPresetHarness onDefaultChange={onDefaultChange} />
      </FontsContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "액션 효과음" }));
    expect(screen.queryByText(/프리셋을 직접 조정합니다/)).toBeNull();
    expect(
      screen.queryByText("새로 만드는 텍스트 블록에 적용할 기본 서식입니다."),
    ).toBeNull();
    const disabledSize = document.querySelector(
      '[data-preset-group="size"][aria-disabled="true"]',
    );
    expect(disabledSize).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "글자 크기" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.queryByRole("slider", { name: "안쪽 여백" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "글자 크기" }));
    fireEvent.click(screen.getByRole("button", { name: "켜짐" }));
    fireEvent.click(screen.getByRole("button", { name: "글자 크기 늘리기" }));

    expect(onDefaultChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("default-size").textContent).toBe("24");
    expect(screen.getByTestId("preset-size").textContent).toBe("24.5");
    expect(screen.getByTestId("preset-groups").textContent).toContain("size");
    expect(screen.getByTestId("preset-auto-fit").textContent).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "글자 크기" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps the final preset field enabled and explains why with a toast", () => {
    render(
      <FontsContext.Provider value={FONT_CONTEXT_VALUE}>
        <FormatPresetHarness onDefaultChange={vi.fn()} />
      </FontsContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "액션 효과음" }));
    fireEvent.click(screen.getByRole("button", { name: "글자색" }));

    expect(screen.getByTestId("preset-groups").textContent).toBe("color");
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]).toMatchObject({
      variant: "warn",
      message: "프리셋에는 최소 1개 항목을 적용해야 합니다.",
    });
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

function FormatPresetHarness({
  onDefaultChange,
}: {
  onDefaultChange: (patch: Partial<BlockFormatDefaults>) => void;
}): React.JSX.Element {
  const [defaults, setDefaults] = React.useState<BlockFormatDefaults>({
    ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
    fontSizePx: 24,
  });
  const [activePresetId, setActivePresetId] = React.useState<string | null>(
    null,
  );
  const [presets, setPresets] = React.useState<BlockStylePreset[]>(() => [
    createBlockStylePresetFromDefaults({
      defaults,
      groupIds: ["color"],
      id: "style-preset:action",
      name: "액션 효과음",
    }),
  ]);
  return (
    <>
      <FormatDefaultsPanel
        activePresetId={activePresetId}
        bubbleLayoutPaddingRatio={0.12}
        stylePresets={presets}
        value={defaults}
        onActivePresetChange={setActivePresetId}
        onBubbleLayoutPaddingRatioChange={() => undefined}
        onChange={(patch) => {
          onDefaultChange(patch);
          setDefaults((current) => ({ ...current, ...patch }));
        }}
        onStylePresetsChange={setPresets}
      />
      <output data-testid="default-size">{defaults.fontSizePx}</output>
      <output data-testid="preset-size">
        {presets[0]?.format.fontSizePx ?? ""}
      </output>
      <output data-testid="preset-groups">
        {presets[0]?.groupIds.join(",")}
      </output>
      <output data-testid="preset-auto-fit">
        {String(presets[0]?.format.autoFitText)}
      </output>
    </>
  );
}

const FONT_CONTEXT_VALUE = {
  busy: false,
  catalog: createBlockFontCatalog([], {
    hiddenIds: [],
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
