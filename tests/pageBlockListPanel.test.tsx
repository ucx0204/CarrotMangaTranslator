/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageBlockListPanel } from "../src/renderer/src/components/PageBlockListPanel";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);

describe("page block list", () => {
  it("renders reading order, status badges, and direct block-id edits", () => {
    const onOpenEditor = vi.fn();
    const onSelectBlock = vi.fn();
    const onUpdateBlock = vi.fn();
    render(
      <PageBlockListPanel
        disabled={false}
        page={makePage()}
        presets={[]}
        readingDirection="rtl"
        selectedBlockId="right"
        onApplyStylePreset={vi.fn()}
        onOpenEditor={onOpenEditor}
        onSelectBlock={onSelectBlock}
        onUpdateBlock={onUpdateBlock}
      />,
    );

    const translations = screen.getAllByRole<HTMLTextAreaElement>("textbox");
    expect(translations.map((field) => field.value)).toEqual([
      "translated-right",
      "translated-left",
      "translated-lower",
    ]);
    expect(screen.getByText("검토 필요")).not.toBeNull();
    expect(screen.getByText("효과음")).not.toBeNull();
    expect(screen.getByText("지우기 제외")).not.toBeNull();

    fireEvent.focus(translations[1] as HTMLTextAreaElement);
    expect(onSelectBlock).toHaveBeenCalledWith("left");
    fireEvent.change(translations[1] as HTMLTextAreaElement, {
      target: { value: "직접 수정" },
    });
    expect(onUpdateBlock).toHaveBeenCalledWith("left", {
      translatedText: "직접 수정",
    });
    expect(screen.getAllByRole("textbox")).toHaveLength(3);

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "상세 편집",
      })[1] as HTMLButtonElement,
    );
    expect(onOpenEditor).toHaveBeenCalledWith("left");
  });

  it("applies only pinned quick presets to the active block", () => {
    const onApplyStylePreset = vi.fn();
    render(
      <PageBlockListPanel
        disabled={false}
        page={makePage()}
        presets={[
          { id: "dialogue", name: "대사", pinned: false, missingFont: false },
          { id: "sfx", name: "효과음 서식", pinned: true, missingFont: true },
        ]}
        readingDirection="ltr"
        selectedBlockId="left"
        onApplyStylePreset={onApplyStylePreset}
        onOpenEditor={vi.fn()}
        onSelectBlock={vi.fn()}
        onUpdateBlock={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "대사" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "효과음 서식" }));
    expect(onApplyStylePreset).toHaveBeenCalledWith("sfx");
  });
});

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page-1.png",
    imagePath: "page-1.png",
    dataUrl: "",
    width: 1000,
    height: 1600,
    blocks: [
      makeBlock("left", 100, 100, { reviewStatus: "needs_review" }),
      makeBlock("lower", 500, 500, { inpaintExcluded: true }),
      makeBlock("right", 600, 110, { textRole: "sound" }),
    ],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(
  id: string,
  x: number,
  y: number,
  patch: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x, y, w: 220, h: 120 },
    sourceText: `source-${id}`,
    translatedText: `translated-${id}`,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    ...patch,
  };
}
