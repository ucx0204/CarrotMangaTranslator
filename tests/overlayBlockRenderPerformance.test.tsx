/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OverlayBlockLayer } from "../src/renderer/src/components/OverlayBlockLayer";
import {
  FontsContext,
  type FontsContextValue,
} from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const measureText = vi.fn((text: string) => ({
  width: Array.from(text).length * 10,
}));
const fontsContext: FontsContextValue = {
  baseOptions: [],
  busy: false,
  catalog: DEFAULT_BLOCK_FONT_CATALOG,
  options: [],
  registerFont: async () => undefined,
  removeFont: async () => undefined,
  savePreferences: async () => undefined,
};

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ font: "", measureText }),
  });
});

afterEach(() => {
  cleanup();
  measureText.mockClear();
});

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
});

describe("overlay block render isolation", () => {
  it("reuses text layout throughout a move-preview burst", () => {
    const store = createWorkspaceInteractionPreviewStore();
    const stationary = makeBlock("stationary", "AAAA", 100);
    const moving = makeBlock("moving", "BBBB", 400);
    const view = renderLayer(makePage([stationary, moving]), store);
    measureText.mockClear();

    for (let index = 0; index < 20; index += 1) {
      act(() => {
        store.set({
          blockPreview: {
            blockId: moving.id,
            block: {
              ...moving,
              bbox: { ...moving.bbox, x: moving.bbox.x + index + 1 },
            },
          },
        });
      });
    }

    expect(measureText).not.toHaveBeenCalled();
    expect(
      view.container.querySelector<HTMLElement>(".overlay-block.selected")
        ?.style.transform,
    ).toContain("translate3d(210px,");
  });

  it("remeasures only the resized block when equal-size props are recreated", () => {
    const store = createWorkspaceInteractionPreviewStore();
    const stationary = makeBlock("stationary", "AAAA", 100);
    const resized = makeBlock("resized", "BBBB", 400);
    const view = renderLayer(makePage([stationary, resized]), store);
    measureText.mockClear();

    view.rerender(
      withFonts(
        <OverlayBlockLayer
          blockPointerDisabled={false}
          imageDataUrl="data:image/png;base64,overlay"
          interactionPreviewStore={store}
          onBlockPointerDown={() => undefined}
          page={makePage([
            stationary,
            { ...resized, bbox: { ...resized.bbox, w: 260 } },
          ])}
          selectedBlockId={resized.id}
          selectedBlockIds={[resized.id]}
          showBlockChrome
          showTextBlocks
          stageSize={{ height: 500, width: 500 }}
          stageTool="select"
          textLayoutStageSize={{ height: 1000, width: 1000 }}
        />,
      ),
    );

    const measuredGlyphs = measureText.mock.calls.map(([text]) => text);
    expect(measuredGlyphs).toContain("B");
    expect(measuredGlyphs).not.toContain("A");
  });
});

function renderLayer(
  page: MangaPage,
  store: ReturnType<typeof createWorkspaceInteractionPreviewStore>,
) {
  return render(
    withFonts(
      <OverlayBlockLayer
        blockPointerDisabled={false}
        imageDataUrl="data:image/png;base64,overlay"
        interactionPreviewStore={store}
        onBlockPointerDown={() => undefined}
        page={page}
        selectedBlockId="moving"
        selectedBlockIds={["moving"]}
        showBlockChrome
        showTextBlocks
        stageSize={{ height: 500, width: 500 }}
        stageTool="select"
        textLayoutStageSize={{ height: 1000, width: 1000 }}
      />,
    ),
  );
}

function withFonts(child: React.ReactElement): React.JSX.Element {
  return (
    <FontsContext.Provider value={fontsContext}>{child}</FontsContext.Provider>
  );
}

function makePage(blocks: TranslationBlock[]): MangaPage {
  return {
    analysisStatus: "completed",
    blocks,
    createdAt: "2026-01-01T00:00:00.000Z",
    dataUrl: "",
    height: 1000,
    id: "page-1",
    imagePath: "C:/page.png",
    name: "page.png",
    updatedAt: "2026-01-01T00:00:00.000Z",
    width: 1000,
  };
}

function makeBlock(
  id: string,
  translatedText: string,
  x: number,
): TranslationBlock {
  return {
    autoFitText: false,
    backgroundColor: "#ffffff",
    bbox: { h: 160, w: 200, x, y: 100 },
    confidence: 1,
    fontSizePx: 24,
    id,
    lineHeight: 1.2,
    opacity: 1,
    renderDirection: "horizontal",
    sourceDirection: "horizontal",
    sourceText: "",
    textAlign: "center",
    textColor: "#000000",
    translatedText,
    type: "nonsolid",
  };
}
