/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranslationBlock } from "../src/shared/textTypes";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { GatherTextDirectFormatModal } from "../src/renderer/src/components/gatherText/GatherTextDirectFormatModal";
import type { GatherTextFormatSelection } from "../src/renderer/src/components/gatherText/useGatherTextFormatSelection";
import { deriveGatherTextDirectFormatModel } from "../src/renderer/src/lib/gatherTextDirectFormatModel";

afterEach(cleanup);

describe("GatherTextDirectFormatModal", () => {
  it("keeps the preview outside one scrolling area with all three editor sections visible", () => {
    const selection = makeSelection();
    const { container } = renderModal(selection);

    const preview = container.querySelector(".gather-direct-preview");
    const controls = container.querySelector(
      ".gather-direct-editor-controls-scroll",
    );
    const sections = controls?.querySelectorAll(
      ":scope > .gather-direct-editor-section",
    );

    expect(preview?.parentElement).toBe(controls?.parentElement);
    expect(controls?.contains(preview)).toBe(false);
    expect(sections).toHaveLength(3);
    expect(container.querySelector(".gather-direct-editor-details")).toBeNull();
    expect(screen.getByRole("slider", { name: "줄 간격" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "자간" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "장평" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "기울기" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "글자 투명도" })).toBeTruthy();
  });

  it("uses a live preview and applies only controls the user changes", () => {
    const selection = makeSelection();
    const { container } = renderModal(selection);

    expect(screen.getByRole("spinbutton", { name: "글자 크기" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "적용" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "글자 크기 늘리기" }));

    const preview = container.querySelector<HTMLElement>(
      ".gather-direct-preview-text",
    );
    expect(preview?.style.fontSize).toBe("25px");
    expect(
      screen.getByRole("button", { name: "적용" }).hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(selection.apply).toHaveBeenCalledWith({
      fontSizePx: 25,
      autoFitText: false,
    });
  });

  it("accepts a font size directly instead of requiring repeated plus clicks", () => {
    const selection = makeSelection();
    const { container } = renderModal(selection);

    fireEvent.change(screen.getByRole("spinbutton", { name: "글자 크기" }), {
      target: { value: "50" },
    });

    expect(
      container.querySelector<HTMLElement>(".gather-direct-preview-text")?.style
        .fontSize,
    ).toBe("50px");
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(selection.apply).toHaveBeenCalledWith({
      fontSizePx: 50,
      autoFitText: false,
    });
  });

  it("lets the sample phrase be edited without adding it to the format patch", () => {
    const selection = makeSelection();
    const { container } = renderModal(selection);
    const sampleInput = screen.getByRole("textbox", { name: "예시 문구" });

    fireEvent.change(sampleInput, { target: { value: "실제 대사 미리보기" } });

    expect(
      container.querySelector(".gather-direct-preview-text")?.textContent,
    ).toBe("실제 대사 미리보기");
    expect(
      screen.getByRole("button", { name: "적용" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("shows synthesized italic styling in the live preview", () => {
    const selection = makeSelection();
    const { container } = renderModal(selection);

    fireEvent.click(screen.getByRole("button", { name: "기울임꼴" }));

    const preview = container.querySelector<HTMLElement>(
      ".gather-direct-preview-text",
    );
    expect(preview?.style.fontStyle).toBe("italic");
    expect(preview?.style.fontSynthesis).toBe("weight style");
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(selection.apply).toHaveBeenCalledWith({ italic: true });
  });

  it("previews and applies text opacity as an output format", () => {
    const selection = makeSelection();
    const { container } = renderModal(selection);

    fireEvent.change(screen.getByRole("slider", { name: "글자 투명도" }), {
      target: { value: "0.45" },
    });

    const previewLayer = container.querySelector<HTMLElement>(
      ".gather-direct-preview-rotation",
    );
    expect(previewLayer?.style.opacity).toBe("0.45");
    expect(screen.queryByText("블록 배경 투명도")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(selection.apply).toHaveBeenCalledWith({ textOpacity: 0.45 });
  });

  it("can explicitly switch mixed selections back to the configured default font", () => {
    const selection = makeSelection();
    renderModal(selection);

    fireEvent.change(screen.getByRole("combobox", { name: "글꼴" }), {
      target: { value: "__gather_default_font__" },
    });
    fireEvent.click(screen.getByRole("button", { name: "적용" }));

    const patch = vi.mocked(selection.apply).mock.calls[0][0];
    expect(Object.hasOwn(patch, "fontFamily")).toBe(true);
    expect(patch.fontFamily).toBeUndefined();
  });
});

function renderModal(selection: GatherTextFormatSelection) {
  return render(
    <FontsContext.Provider
      value={{
        busy: false,
        customFonts: [],
        preferences: {
          favoriteIds: [],
          orderedIds: [],
          defaultFontId: "nanum-gothic",
        },
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
          {
            id: "seoul-hangang",
            label: "서울한강",
            cssFamily: '"Seoul Hangang", serif',
            sample: "서울한강 Aa",
          },
        ],
        registerFont: async () => undefined,
        removeFont: async () => undefined,
        savePreferences: async () => undefined,
      }}
    >
      <GatherTextDirectFormatModal selection={selection} />
    </FontsContext.Provider>,
  );
}

function makeSelection(): GatherTextFormatSelection {
  return {
    apply: vi.fn(),
    clear: vi.fn(),
    closeFormatModal: vi.fn(),
    disabled: false,
    enterSelectionMode: vi.fn(),
    exitSelectionMode: vi.fn(),
    formatModel: deriveGatherTextDirectFormatModel([
      makeBlock({ fontFamily: "nanum-gothic", fontSizePx: 24 }),
      makeBlock({ fontFamily: "seoul-hangang", fontSizePx: 36 }),
    ]),
    isFormatModalOpen: true,
    isSelectionMode: true,
    isSelected: () => true,
    openFormatModal: vi.fn(),
    selectAllVisible: vi.fn(),
    selectedCount: 2,
    toggle: vi.fn(),
  };
}

function makeBlock(
  overrides: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id: "block",
    type: "nonsolid",
    bbox: { x: 1, y: 2, w: 3, h: 4 },
    sourceText: "source",
    translatedText: "translation",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "transparent",
    opacity: 1,
    ...overrides,
  };
}
