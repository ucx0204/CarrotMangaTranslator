/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranslationBlock } from "../src/shared/textTypes";
import { EditorColorGroup } from "../src/renderer/src/components/EditorColorGroup";

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
