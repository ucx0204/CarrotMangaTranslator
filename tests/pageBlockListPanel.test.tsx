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
    const { container, rerender } = render(
      <PageBlockListPanel
        disabled={false}
        page={makePage()}
        readingDirection="rtl"
        selectedBlockId="right"
        onOpenEditor={onOpenEditor}
        onSelectBlock={onSelectBlock}
        onUpdateBlock={onUpdateBlock}
      />,
    );

    const translations = screen.getAllByRole<HTMLTextAreaElement>("textbox");
    expect(translations.map((field) => field.value)).toEqual([
      "translated-right",
    ]);
    expect(
      container.querySelectorAll(".page-block-list-row.compact"),
    ).toHaveLength(2);
    expect(screen.getByText("검토 필요")).not.toBeNull();
    expect(screen.getByText("효과음")).not.toBeNull();
    expect(screen.getByText("지우기 제외")).not.toBeNull();

    rerender(
      <PageBlockListPanel
        disabled={false}
        page={makePage()}
        readingDirection="rtl"
        selectedBlockId={null}
        onOpenEditor={onOpenEditor}
        onSelectBlock={onSelectBlock}
        onUpdateBlock={onUpdateBlock}
      />,
    );
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    fireEvent.click(
      container.querySelector(
        '[data-page-block-id="left"] .page-block-summary-button',
      ) as HTMLButtonElement,
    );
    expect(onSelectBlock).toHaveBeenCalledWith("left");

    rerender(
      <PageBlockListPanel
        disabled={false}
        page={makePage()}
        readingDirection="rtl"
        selectedBlockId="left"
        onOpenEditor={onOpenEditor}
        onSelectBlock={onSelectBlock}
        onUpdateBlock={onUpdateBlock}
      />,
    );
    onSelectBlock.mockClear();
    const selectedTranslation =
      screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.focus(selectedTranslation);
    expect(onSelectBlock).toHaveBeenCalledWith("left");
    onSelectBlock.mockClear();
    fireEvent.change(selectedTranslation, {
      target: { value: "직접 수정" },
    });
    expect(onUpdateBlock).toHaveBeenCalledWith("left", {
      translatedText: "직접 수정",
    });
    expect(screen.getAllByRole("textbox")).toHaveLength(1);

    fireEvent.click(
      container.querySelector('[data-page-block-id="left"]') as HTMLElement,
    );
    expect(onSelectBlock).toHaveBeenCalledWith("left");

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "상세 편집",
      })[1] as HTMLButtonElement,
    );
    expect(onOpenEditor).toHaveBeenCalledWith("left");

    fireEvent.click(screen.getByRole("button", { name: "검토만" }));
    expect(container.querySelectorAll("[data-page-block-id]")).toHaveLength(1);
    expect(
      container.querySelector('[data-page-block-id="left"]'),
    ).not.toBeNull();
    expect(screen.getByText("검토 1개 남음")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
    expect(container.querySelectorAll("[data-page-block-id]")).toHaveLength(3);
  });

  it("keeps formatting controls out of the page block list", () => {
    render(
      <PageBlockListPanel
        disabled={false}
        page={makePage()}
        readingDirection="ltr"
        selectedBlockId="left"
        onOpenEditor={vi.fn()}
        onSelectBlock={vi.fn()}
        onUpdateBlock={vi.fn()}
      />,
    );

    expect(screen.queryByText("빠른 서식")).toBeNull();
    expect(screen.queryByLabelText("빠른 서식")).toBeNull();
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
