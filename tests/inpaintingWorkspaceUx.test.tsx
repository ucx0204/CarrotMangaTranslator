/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasActionBar } from "../src/renderer/src/components/CanvasActionBar";
import { InpaintingBlockOption } from "../src/renderer/src/components/EditorPanelSections";
import { OverlayBlock } from "../src/renderer/src/components/OverlayBlock";
import { OverlayBlockLayer } from "../src/renderer/src/components/imageStageLayers";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

afterEach(() => cleanup());

describe("persistent canvas actions", () => {
  it("uses the next history entry in labels and disables unavailable actions", () => {
    const onUndo = vi.fn();
    render(
      <CanvasActionBar
        canRedo={false}
        canUndo={true}
        disabled={false}
        compareAvailable={false}
        resetAvailable={false}
        peeking={false}
        redoLabel={null}
        undoLabel="텍스트 편집"
        onPeekToggle={vi.fn()}
        onRedo={vi.fn()}
        onResetPage={vi.fn()}
        onUndo={onUndo}
      />,
    );

    const undo = screen.getByRole("button", {
      name: "텍스트 편집 실행 취소 (Ctrl+Z)",
    });
    expect(undo.hasAttribute("title")).toBe(false);
    expect(
      screen.getByRole("tooltip", {
        name: "텍스트 편집 실행 취소 (Ctrl+Z)",
      }),
    ).not.toBeNull();
    expect(undo.getAttribute("aria-describedby")).toBe(
      screen.getByRole("tooltip", {
        name: "텍스트 편집 실행 취소 (Ctrl+Z)",
      }).id,
    );
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledOnce();
    expect(
      (
        screen.getByRole("button", {
          name: "다시 실행 (Ctrl+Y / Ctrl+Shift+Z)",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "원본과 비교" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "원본으로 초기화",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("keeps reset available when original comparison is unavailable", () => {
    const onResetPage = vi.fn();
    render(
      <CanvasActionBar
        canRedo={false}
        canUndo={false}
        compareAvailable={false}
        disabled={false}
        resetAvailable={true}
        peeking={false}
        onPeekToggle={vi.fn()}
        onRedo={vi.fn()}
        onResetPage={onResetPage}
        onUndo={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "원본과 비교" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const reset = screen.getByRole("button", {
      name: "원본으로 초기화",
    }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);

    fireEvent.click(reset);
    expect(onResetPage).toHaveBeenCalledOnce();
  });
});

describe("automatic erase exclusion", () => {
  it("toggles exclusion from the selected block editor", () => {
    const onUpdate = vi.fn();
    render(
      <InpaintingBlockOption
        block={makeBlock(false)}
        disabled={false}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: /자동 지우기에서 제외/ }),
    );
    expect(onUpdate).toHaveBeenCalledWith({ inpaintExcluded: true });
    expect(
      screen.queryByText("자동 인페인팅이 이 블록의 글자를 지우지 않습니다."),
    ).toBeNull();
  });

  it("always marks an excluded block on the canvas", () => {
    const { container } = render(
      <OverlayBlock
        block={makeBlock(true)}
        pageSize={{ width: 1000, height: 1600 }}
        stageSize={{ width: 500, height: 800 }}
        selected={false}
        showChrome={false}
        textLayoutStageSize={{ width: 500, height: 800 }}
        onPointerDown={vi.fn()}
        onResizePointerDown={vi.fn()}
      />,
    );

    const badge = screen.getByRole("img", {
      name: "자동 지우기에서 제외된 블록",
    });
    expect(badge).not.toBeNull();
    expect(badge.hasAttribute("title")).toBe(false);
    expect(container.querySelector(".overlay-block.excluded")).not.toBeNull();
  });

  it("renders text opacity independently from the editor block background", () => {
    const { container } = render(
      <OverlayBlock
        block={{ ...makeBlock(false), textOpacity: 0.35, opacity: 0.7 }}
        pageSize={{ width: 1000, height: 1600 }}
        stageSize={{ width: 500, height: 800 }}
        selected
        showChrome
        textLayoutStageSize={{ width: 500, height: 800 }}
        onPointerDown={vi.fn()}
        onResizePointerDown={vi.fn()}
      />,
    );

    const text = container.querySelector<HTMLElement>(".overlay-text");
    const chrome = container.querySelector<HTMLElement>(
      ".overlay-block-chrome",
    );
    expect(text?.style.opacity).toBe("0.35");
    expect(chrome?.style.backgroundColor).toContain("0.7");
  });

  it("keeps only excluded badges visible when text blocks are hidden", () => {
    const page = makePage([
      {
        ...makeBlock(true),
        id: "excluded-block",
        translatedText: "excluded text",
      },
      {
        ...makeBlock(false),
        id: "ordinary-block",
        translatedText: "ordinary text",
      },
    ]);
    const { container } = render(
      <OverlayBlockLayer
        blockPointerDisabled={false}
        imageDataUrl="data:image/png;base64,abc"
        onBlockPointerDown={vi.fn()}
        page={page}
        selectedBlockId={null}
        selectedBlockIds={[]}
        showBlockChrome={false}
        showTextBlocks={false}
        stageSize={{ width: 500, height: 800 }}
        textLayoutStageSize={{ width: 500, height: 800 }}
      />,
    );

    expect(
      screen.getByRole("img", { name: "자동 지우기에서 제외된 블록" }),
    ).not.toBeNull();
    expect(screen.queryByText("excluded text")).toBeNull();
    expect(screen.queryByText("ordinary text")).toBeNull();
    expect(container.querySelectorAll(".overlay-block")).toHaveLength(1);
    expect(container.querySelector(".overlay-block.excluded")).not.toBeNull();
  });
});

function makePage(blocks: TranslationBlock[]): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "C:/page.png",
    dataUrl: "",
    width: 1000,
    height: 1600,
    blocks,
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(inpaintExcluded: boolean): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 300, h: 160 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "vertical",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
    inpaintExcluded,
  };
}
