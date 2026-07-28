/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayBlock } from "../src/renderer/src/components/OverlayBlock";
import { OverlayBlockLayer } from "../src/renderer/src/components/OverlayBlockLayer";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

afterEach(() => cleanup());

describe("automatic erase exclusion", () => {
  it("always marks an excluded block on the canvas", () => {
    const { container } = renderWithFonts(
      <OverlayBlock
        block={makeBlock(true)}
        interactionPreviewStore={createWorkspaceInteractionPreviewStore()}
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
    const { container } = renderWithFonts(
      <OverlayBlock
        block={{ ...makeBlock(false), textOpacity: 0.35, opacity: 0.7 }}
        interactionPreviewStore={createWorkspaceInteractionPreviewStore()}
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
    const { container } = renderWithFonts(
      <OverlayBlockLayer
        blockPointerDisabled={false}
        imageDataUrl="data:image/png;base64,abc"
        interactionPreviewStore={createWorkspaceInteractionPreviewStore()}
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

function renderWithFonts(ui: React.ReactElement): ReturnType<typeof render> {
  return render(
    <FontsContext.Provider
      value={{
        busy: false,
        catalog: DEFAULT_BLOCK_FONT_CATALOG,
        baseOptions: [],
        options: [],
        registerFont: async () => undefined,
        removeFont: async () => undefined,
        savePreferences: async () => undefined,
      }}
    >
      {ui}
    </FontsContext.Provider>,
  );
}

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
