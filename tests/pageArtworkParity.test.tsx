/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OverlayBlock } from "../src/renderer/src/components/OverlayBlock";
import { PageArtwork } from "../src/renderer/src/components/PageArtwork";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import type { TranslationBlock } from "../src/shared/textTypes";

const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 11 }),
    }),
  });
});

afterEach(cleanup);

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
});

describe("page artwork renderer parity", () => {
  it("uses byte-identical artwork DOM apart from editor-only annotations", () => {
    const blocks = makeBlocks();
    const page = {
      id: "page-parity",
      name: "page.png",
      width: 1000,
      height: 1400,
      blocks,
    };
    const visualSize = { width: 836, height: 1200 };
    const exported = render(
      <PageArtwork
        fontCatalog={DEFAULT_BLOCK_FONT_CATALOG}
        imageSrc="data:image/png;base64,"
        page={page}
        visualSize={visualSize}
      />,
    );
    const panel = render(
      withFonts(
        <>
          {blocks.map((block) => (
            <OverlayBlock
              block={block}
              interactionPreviewStore={createWorkspaceInteractionPreviewStore()}
              key={block.id}
              onPointerDown={() => undefined}
              onResizePointerDown={() => undefined}
              pageSize={{ width: page.width, height: page.height }}
              pointerDisabled
              selected={false}
              showChrome={false}
              stageSize={visualSize}
              textLayoutStageSize={{
                width: page.width,
                height: page.height,
              }}
            />
          ))}
        </>,
      ),
    );

    expect(readArtworkBlocks(exported.container)).toEqual(
      readArtworkBlocks(panel.container),
    );
    const bubbleLine = exported.container.querySelector<HTMLElement>(
      '[data-bubble-slot=""]',
    );
    expect(bubbleLine).not.toBeNull();
    expect(bubbleLine?.style.position).toBe("absolute");
    expect(bubbleLine?.style.width).not.toBe("");
    expect(bubbleLine?.parentElement?.style.maxWidth).toBe("none");
    expect(bubbleLine?.parentElement?.style.flexShrink).toBe("0");
    expect(bubbleLine?.parentElement?.style.transform).toBe("scaleX(0.8)");
    const verticalBubbleColumn = exported.container.querySelector<HTMLElement>(
      '[data-bubble-direction="vertical"]',
    );
    expect(verticalBubbleColumn).not.toBeNull();
    expect(verticalBubbleColumn?.style.position).toBe("absolute");
    expect(verticalBubbleColumn?.style.writingMode).toBe("vertical-rl");
    expect(verticalBubbleColumn?.style.height).not.toBe("");
    expect(verticalBubbleColumn?.style.width).not.toBe("");
    expect(verticalBubbleColumn?.parentElement?.style.width).not.toBe(
      "max-content",
    );
    const effectLayers = Array.from(
      exported.container.querySelectorAll<HTMLElement>(".text-effect-layer"),
    );
    expect(effectLayers).toHaveLength(4);
    expect(effectLayers.map((layer) => layer.style.filter)).toEqual([
      "drop-shadow(2.508px 4.2857px 5.926px rgba(18, 52, 86, 0.7))",
      "drop-shadow(0px 0px 8.4657px rgba(68, 102, 204, 0.8))",
      "drop-shadow(-3.344px 5.1429px 10.1589px rgba(136, 34, 68, 0.55))",
      "drop-shadow(1.672px -2.5714px 4.2329px rgba(34, 119, 85, 0.65))",
    ]);
    expect(
      exported.container.querySelector(
        ".text-effect-layer .overlay-block-chrome",
      ),
    ).toBeNull();
  });

  it("keeps persisted outlines identical in editor and export", () => {
    const blocks = [
      makeBlock("automatic-dark", {
        translatedText: "자동 검정",
        textColor: "#111111",
        outlineColor: "#ffffff",
        outlineWidthScale: 1,
      }),
      makeBlock("automatic-inverse-curve", {
        bbox: { x: 100, y: 350, w: 500, h: 180 },
        translatedText: "자동 흰색",
        textColor: "#f7f7f2",
        outlineColor: "#111111",
        outlineWidthScale: 1,
        curveLayout: {
          version: 1,
          alignment: "center",
          offsetEm: 0,
          orientation: "tangent",
          path: {
            type: "quadratic",
            start: { x: 0.05, y: 0.7 },
            control: { x: 0.5, y: 0.05 },
            end: { x: 0.95, y: 0.7 },
          },
        },
      }),
    ];
    const page = {
      id: "outline-parity",
      name: "outline.png",
      width: 1000,
      height: 800,
      blocks,
    };
    const visualSize = { width: 1000, height: 800 };
    const exported = render(
      <PageArtwork
        fontCatalog={DEFAULT_BLOCK_FONT_CATALOG}
        imageSrc="data:image/png;base64,"
        page={page}
        visualSize={visualSize}
      />,
    );
    const panel = render(
      withFonts(
        <>
          {blocks.map((block) => (
            <OverlayBlock
              block={block}
              interactionPreviewStore={createWorkspaceInteractionPreviewStore()}
              key={block.id}
              onPointerDown={() => undefined}
              onResizePointerDown={() => undefined}
              pageSize={{ width: page.width, height: page.height }}
              pointerDisabled
              selected={false}
              showChrome={false}
              stageSize={visualSize}
              textLayoutStageSize={visualSize}
            />
          ))}
        </>,
      ),
    );

    for (const container of [exported.container, panel.container]) {
      const normal = Array.from(
        container.querySelectorAll<HTMLElement>(".overlay-text-content"),
      ).find((element) => element.textContent === "자동 검정");
      expect(normal?.style.textShadow).toBe("none");
      expect(normal?.style.webkitTextStrokeColor).toBe("rgb(255, 255, 255)");
      expect(
        Number.parseFloat(normal?.style.webkitTextStrokeWidth ?? "0"),
      ).toBeGreaterThan(0);
      const curveGlyph = container.querySelector<SVGTextElement>(
        'svg[aria-label="자동 흰색"] text',
      );
      expect(curveGlyph?.getAttribute("fill")).toBe("#f7f7f2");
      expect(curveGlyph?.getAttribute("stroke")).toBe("#111111");
      expect(Number(curveGlyph?.getAttribute("stroke-width"))).toBeGreaterThan(
        0,
      );
    }
  });
});

function withFonts(children: React.ReactNode): React.JSX.Element {
  return (
    <FontsContext.Provider
      value={{
        baseOptions: [],
        busy: false,
        catalog: DEFAULT_BLOCK_FONT_CATALOG,
        options: [],
        registerFont: async () => undefined,
        removeFont: async () => undefined,
        savePreferences: async () => undefined,
      }}
    >
      {children}
    </FontsContext.Provider>
  );
}

function readArtworkBlocks(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".overlay-block"),
    (block) => {
      const artwork = block.cloneNode(true) as HTMLElement;
      artwork
        .querySelectorAll(".overlay-block-chrome, .overlay-excluded-badge")
        .forEach((annotation) => annotation.remove());
      return artwork.outerHTML;
    },
  );
}

function makeBlocks(): TranslationBlock[] {
  return [
    makeBlock("rich", {
      bbox: { x: 123.4, y: 80.25, w: 281.5, h: 144.75 },
      translatedText: "**굵게** 그리고 *기울임*",
      rotationDeg: 13.5,
      fontWidthScale: 0.86,
      letterSpacing: 0.08,
      textEffect: {
        enabled: true,
        color: "#123456",
        offsetXpx: 3,
        offsetYpx: 5,
        blurPx: 7,
        opacity: 0.7,
      },
    }),
    makeBlock("vertical", {
      bbox: { x: 620.2, y: 120.4, w: 150.7, h: 370.3 },
      renderDirection: "vertical",
      translatedText: "세로쓰기",
      textEffect: {
        enabled: true,
        color: "#4466cc",
        offsetXpx: 0,
        offsetYpx: 0,
        blurPx: 10,
        opacity: 0.8,
      },
      wordBreak: "keep-all",
    }),
    makeBlock("perspective", {
      bbox: { x: 170.1, y: 530.6, w: 520.8, h: 120.2 },
      perspectiveTransform: {
        version: 1,
        corners: [
          { x: 0.04, y: 0.1 },
          { x: 0.98, y: 0 },
          { x: 0.91, y: 0.94 },
          { x: 0.02, y: 0.82 },
        ],
      },
      textEffect: {
        enabled: true,
        color: "#882244",
        offsetXpx: -4,
        offsetYpx: 6,
        blurPx: 12,
        opacity: 0.55,
      },
      translatedText: "원근 변환",
    }),
    makeBlock("curve", {
      bbox: { x: 110.5, y: 760.25, w: 700.5, h: 180.75 },
      curveLayout: {
        version: 1,
        alignment: "center",
        fitSpacing: true,
        offsetEm: 0.15,
        orientation: "tangent",
        path: {
          type: "quadratic",
          start: { x: 0.05, y: 0.7 },
          control: { x: 0.5, y: 0.05 },
          end: { x: 0.95, y: 0.7 },
        },
      },
      textEffect: {
        enabled: true,
        color: "#227755",
        offsetXpx: 2,
        offsetYpx: -3,
        blurPx: 5,
        opacity: 0.65,
      },
      translatedText: "곡선 텍스트",
    }),
    makeBlock("empty", {
      bbox: { x: 80, y: 1030, w: 240, h: 90 },
      sourceText: "",
      translatedText: "",
    }),
    makeBlock("excluded", {
      bbox: { x: 420, y: 1030, w: 360, h: 90 },
      inpaintExcluded: true,
      translatedText: "인페인팅 제외 텍스트",
    }),
    makeBlock("bubble", {
      autoFitText: false,
      bbox: { x: 650, y: 980, w: 280, h: 180 },
      fontWidthScale: 0.8,
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 0.96,
        insetRatio: 0.04,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0.12,
                inlineEnd: 0.88,
              },
            ],
          },
        ],
      },
      fontSizePx: 24,
      lineHeight: 1,
      translatedText: "말풍선 모양 줄배치",
    }),
    makeBlock("vertical-bubble", {
      autoFitText: false,
      bbox: { x: 330, y: 760, w: 280, h: 180 },
      renderBbox: { x: 330, y: 760, w: 280, h: 180 },
      fontWidthScale: 0.75,
      bubbleLayout: {
        version: 1,
        direction: "vertical",
        confidence: 0.96,
        insetRatio: 0.04,
        regions: [
          {
            spans: [
              {
                blockStart: 0.1,
                blockEnd: 0.9,
                inlineStart: 0.12,
                inlineEnd: 0.88,
              },
            ],
          },
        ],
      },
      fontSizePx: 24,
      lineHeight: 1,
      renderDirection: "vertical",
      sourceDirection: "vertical",
      translatedText: "세로 말풍선",
    }),
  ];
}

function makeBlock(
  id: string,
  overrides: Partial<TranslationBlock>,
): TranslationBlock {
  return {
    autoFitText: true,
    backgroundColor: "#ffffff",
    bbox: { x: 100, y: 100, w: 300, h: 160 },
    confidence: 1,
    fontFamily: "nanum-myeongjo",
    fontSizePx: 32,
    id,
    lineHeight: 1.18,
    opacity: 1,
    renderDirection: "horizontal",
    sourceDirection: "horizontal",
    sourceText: "",
    textAlign: "center",
    textColor: "#111111",
    translatedText: "텍스트",
    type: "nonsolid",
    ...overrides,
  };
}
