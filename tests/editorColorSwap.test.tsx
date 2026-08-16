/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  EditorColorGroup,
  EditorTextEffectGroup,
} from "../src/renderer/src/components/EditorColorGroup";

afterEach(() => cleanup());

describe("editor text and outline color swap", () => {
  it("swaps the resolved text and outline colors in one edit", () => {
    const onUpdate = vi.fn();
    render(
      <EditorColorGroup
        block={makeBlock({
          textColor: "#111111",
          outlineColor: "#fefefe",
        })}
        disabled={false}
        model={{
          autoFitText: true,
          fontSizePx: 24,
          outlineColor: "#fefefe",
          renderDirection: "horizontal",
        }}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "글자색과 외곽선색 바꾸기",
      }),
    );

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledWith({
      textColor: "#fefefe",
      outlineColor: "#111111",
    });
  });

  it("uses editor fallbacks and stays disabled with the panel", () => {
    const onUpdate = vi.fn();
    render(
      <EditorColorGroup
        block={makeBlock({ textColor: "invalid", outlineColor: undefined })}
        disabled
        model={{
          autoFitText: true,
          fontSizePx: 24,
          outlineColor: "#ffffff",
          renderDirection: "horizontal",
        }}
        onUpdate={onUpdate}
      />,
    );

    const button = screen.getByRole("button", {
      name: "글자색과 외곽선색 바꾸기",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("offers an outline checkbox and converts only manual edits to pixels", () => {
    const onUpdate = vi.fn();
    const { rerender } = render(
      <EditorColorGroup
        block={makeBlock({ outlineColor: "#ffffff", outlineWidthScale: 1 })}
        disabled={false}
        model={{
          autoFitText: true,
          fontSizePx: 24,
          outlineColor: "#ffffff",
          renderDirection: "horizontal",
        }}
        onUpdate={onUpdate}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "외곽선 사용" });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox);
    expect(onUpdate).toHaveBeenLastCalledWith({ outlineWidthPx: 0 });

    rerender(
      <EditorColorGroup
        block={makeBlock({ outlineColor: "#ffffff", outlineWidthPx: 0 })}
        disabled={false}
        model={{
          autoFitText: true,
          fontSizePx: 24,
          outlineColor: "#ffffff",
          renderDirection: "horizontal",
        }}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "외곽선 사용" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ outlineWidthPx: 1.5 });

    rerender(
      <EditorColorGroup
        block={makeBlock({ outlineColor: "#ffffff", outlineWidthPx: 1.5 })}
        disabled={false}
        model={{
          autoFitText: true,
          fontSizePx: 24,
          outlineColor: "#ffffff",
          renderDirection: "horizontal",
        }}
        onUpdate={onUpdate}
      />,
    );
    const input = screen.getByRole("spinbutton", { name: "외곽선 굵기" });
    fireEvent.change(input, { target: { value: "32" } });
    fireEvent.blur(input);
    expect(onUpdate).toHaveBeenLastCalledWith({ outlineWidthPx: 32 });
  });
});

describe("editor text shadow and glow controls", () => {
  it("starts disabled, preserves explicit values, and commits direct numeric edits", () => {
    const onUpdate = vi.fn();
    const { rerender } = render(
      <EditorTextEffectGroup
        block={makeBlock()}
        disabled={false}
        onUpdate={onUpdate}
      />,
    );

    const enabled = screen.getByRole("checkbox", { name: "효과 사용" });
    expect((enabled as HTMLInputElement).checked).toBe(false);
    expect(
      (
        screen.getByRole("spinbutton", {
          name: "X 위치",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(enabled);
    expect(onUpdate).toHaveBeenLastCalledWith({
      textEffect: {
        enabled: true,
        color: "#000000",
        offsetXpx: 2,
        offsetYpx: 2,
        blurPx: 4,
        opacity: 0.5,
      },
    });

    const textEffect = {
      enabled: true,
      color: "#123456",
      offsetXpx: 2,
      offsetYpx: 2,
      blurPx: 4,
      opacity: 0.5,
    };
    rerender(
      <EditorTextEffectGroup
        block={makeBlock({ textEffect })}
        disabled={false}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "효과 사용" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      textEffect: { ...textEffect, enabled: false },
    });

    fireEvent.change(screen.getByRole("textbox", { name: "효과 색상 HEX" }), {
      target: { value: "#abcdef" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({
      textEffect: { ...textEffect, color: "#abcdef" },
    });

    const offsetX = screen.getByRole("spinbutton", { name: "X 위치" });
    fireEvent.change(offsetX, { target: { value: "-12.5" } });
    fireEvent.blur(offsetX);
    expect(onUpdate).toHaveBeenLastCalledWith({
      textEffect: { ...textEffect, offsetXpx: -12.5 },
    });

    const offsetY = screen.getByRole("spinbutton", { name: "Y 위치" });
    fireEvent.change(offsetY, { target: { value: "-8" } });
    fireEvent.blur(offsetY);
    expect(onUpdate).toHaveBeenLastCalledWith({
      textEffect: { ...textEffect, offsetYpx: -8 },
    });

    const blur = screen.getByRole("spinbutton", { name: "블러" });
    fireEvent.change(blur, { target: { value: "20.5" } });
    fireEvent.blur(blur);
    expect(onUpdate).toHaveBeenLastCalledWith({
      textEffect: { ...textEffect, blurPx: 20.5 },
    });

    const opacity = screen.getByRole("spinbutton", { name: "불투명도" });
    fireEvent.change(opacity, { target: { value: "35" } });
    fireEvent.blur(opacity);
    expect(onUpdate).toHaveBeenLastCalledWith({
      textEffect: { ...textEffect, opacity: 0.35 },
    });
  });

  it("disables the complete effect editor with the block panel", () => {
    render(
      <EditorTextEffectGroup
        block={makeBlock({
          textEffect: {
            enabled: true,
            color: "#000000",
            offsetXpx: 0,
            offsetYpx: 0,
            blurPx: 12,
            opacity: 0.8,
          },
        })}
        disabled
        onUpdate={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole("checkbox", { name: "효과 사용" }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    for (const input of screen.getAllByRole("spinbutton")) {
      expect((input as HTMLInputElement).disabled).toBe(true);
    }
  });
});

function makeBlock(patch: Partial<TranslationBlock> = {}): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    sourceText: "원문",
    translatedText: "번역",
    confidence: 1,
    sourceDirection: "vertical",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    autoFitText: true,
    ...patch,
  };
}
