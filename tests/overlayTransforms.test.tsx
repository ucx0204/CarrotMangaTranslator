/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OverlayBlock } from "../src/renderer/src/components/OverlayBlock";
import { OverlayText } from "../src/renderer/src/components/OverlayText";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import type { DragMode } from "../src/renderer/src/lib/workspaceInteractionTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  createIdentityWarpTransform,
  createWarpPreset,
} from "../src/shared/blockTransforms";

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataUrl = HTMLCanvasElement.prototype.toDataURL;

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
      putImageData: vi.fn(),
    }),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: () => "data:image/png;base64,AA==",
  });
});

afterEach(() => cleanup());

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: originalToDataUrl,
  });
});

describe("overlay transform controls", () => {
  it("renders eight local resize handles and a rotation handle", () => {
    const onTransformPointerDown = vi.fn();
    const { container } = renderOverlay({ onTransformPointerDown });

    expect(container.querySelectorAll("[data-transform-handle]")).toHaveLength(
      9,
    );
    const rotate = container.querySelector<HTMLElement>(
      '[data-transform-handle="rotate"]',
    );
    if (!rotate) throw new Error("Rotation handle was not rendered");
    fireEvent.pointerDown(rotate);
    expect(onTransformPointerDown).toHaveBeenCalledWith(
      expect.anything(),
      "rotate",
    );
  });

  it("warps content inside rotation and shows all perspective handles", () => {
    const block: TranslationBlock = {
      ...makeBlock(),
      rotationDeg: 12,
      perspectiveTransform: {
        version: 1 as const,
        corners: [
          { x: 0.08, y: 0.04 },
          { x: 0.92, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 0.92 },
        ],
      },
    };
    const { container } = renderOverlay({
      block,
      transformMode: "perspective",
    });

    expect(
      container.querySelector<HTMLElement>(".overlay-block")?.style.transform,
    ).toContain("rotate(12deg)");
    expect(
      container.querySelector<HTMLElement>(".overlay-transform-content")?.style
        .transform,
    ).toContain("matrix3d(");
    expect(container.querySelectorAll("[data-transform-handle]")).toHaveLength(
      8,
    );
    expect(container.querySelector(".transform-guide polygon")).not.toBeNull();
  });

  it("renders rich text as positioned curve glyphs with three path handles", () => {
    const { container } = renderOverlay({
      block: {
        ...makeBlock(),
        translatedText: "A**BC**",
        curveLayout: makeCurveLayout(),
      },
      transformMode: "curve",
    });

    expect(container.querySelectorAll(".overlay-curve-text text")).toHaveLength(
      3,
    );
    expect(container.querySelectorAll("[data-transform-handle]")).toHaveLength(
      3,
    );
    expect(container.querySelector(".curve-path-line")).not.toBeNull();
  });

  it("renders per-character size, font, and opacity in ordinary and curved text", () => {
    const translatedText =
      "[font=nanum-myeongjo][size=56][opacity=40]A[/opacity][/size][/font]B";
    const ordinary = renderOverlay({
      block: { ...makeBlock(), translatedText, textOpacity: 0.8 },
    });
    const ordinaryRuns = ordinary.container.querySelectorAll<HTMLElement>(
      ".overlay-text-line > span",
    );
    expect(ordinaryRuns[0]?.style.fontSize).toBe("28px");
    expect(ordinaryRuns[0]?.style.fontFamily).toContain("MGT Nanum Myeongjo");
    expect(ordinaryRuns[0]?.style.opacity).toBe("0.4");
    expect(ordinaryRuns[1]?.style.fontSize).toBe("14px");
    expect(ordinaryRuns[1]?.style.opacity).toBe("0.8");
    ordinary.unmount();

    const curved = renderOverlay({
      block: { ...makeBlock(), translatedText, curveLayout: makeCurveLayout() },
      transformMode: "curve",
    });
    const glyphs = curved.container.querySelectorAll(
      ".overlay-curve-text text",
    );
    expect(glyphs[0]?.getAttribute("font-size")).toBe("28");
    expect(glyphs[0]?.getAttribute("font-family")).toContain(
      "MGT Nanum Myeongjo",
    );
    expect(glyphs[0]?.getAttribute("opacity")).toBe("0.4");
    expect(glyphs[1]?.getAttribute("font-size")).toBe("14");
  });

  it("renders empty and styled runs when fixed lines switch writing direction", () => {
    const block = {
      ...makeBlock(),
      renderDirection: "vertical" as const,
    };
    const { container, rerender } = render(
      <OverlayText
        block={block}
        displayText=""
        fontCatalog={DEFAULT_BLOCK_FONT_CATALOG}
        layout={{
          rect: { left: 0, top: 0, width: 100, height: 160 },
          paddingPx: 0,
          layoutWidth: 100,
          layoutHeight: 160,
          innerWidth: 100,
          innerHeight: 160,
          fitInnerWidth: 100,
          fitInnerHeight: 160,
          fontSizePx: 20,
          textContentWidth: 100,
          lines: [
            {
              runs: [],
              width: 0,
              slot: {
                blockOffsetPx: 60,
                inlineOffsetPx: 0,
                availableWidth: 80,
                regionIndex: 0,
              },
            },
            {
              runs: [
                { text: "세", bold: false, italic: false },
                {
                  text: "로",
                  bold: false,
                  italic: true,
                  renderedFontSizePx: 30,
                },
              ],
              width: 50,
              slot: {
                blockOffsetPx: 20,
                inlineOffsetPx: 80,
                availableWidth: 80,
                regionIndex: 0,
              },
            },
          ],
          textScaleX: 1,
          textScaleY: 1,
          overflow: false,
        }}
        renderDirection="vertical"
      />,
    );

    const lines = container.querySelectorAll<HTMLElement>(".overlay-text-line");
    expect(lines[0]?.textContent).toBe("\u00a0");
    expect(lines[1]?.style.width).toBe("36px");
    expect(
      lines[1]?.querySelectorAll(":scope > span")[1]?.getAttribute("style"),
    ).toContain("font-style: italic");

    rerender(
      <OverlayText
        block={{ ...block, renderDirection: "horizontal" }}
        displayText="[opacity=40]A[/opacity]B"
        fontCatalog={DEFAULT_BLOCK_FONT_CATALOG}
        layout={{
          rect: { left: 0, top: 0, width: 100, height: 160 },
          paddingPx: 0,
          layoutWidth: 100,
          layoutHeight: 160,
          innerWidth: 100,
          innerHeight: 160,
          fitInnerWidth: 100,
          fitInnerHeight: 160,
          fontSizePx: 20,
          textContentWidth: 100,
          lines: null,
          textScaleX: 1,
          textScaleY: 1,
          overflow: false,
        }}
        renderDirection="horizontal"
      />,
    );
    const parsedRuns = container.querySelectorAll<HTMLElement>(
      ".overlay-text-content > span",
    );
    expect(parsedRuns[0]?.style.opacity).toBe("0.4");
    expect(parsedRuns[1]?.style.opacity).toBe("1");
  });

  it("shows the selected bubble profile even when block chrome is hidden", () => {
    const block: TranslationBlock = {
      ...makeBlock(),
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 1,
        origin: "manual",
        modelId: "manual-shape-v1",
        insetRatio: 0,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 0.5,
                inlineStart: 0.18,
                inlineEnd: 0.82,
              },
              {
                blockStart: 0.5,
                blockEnd: 1,
                inlineStart: 0.08,
                inlineEnd: 0.92,
              },
            ],
          },
        ],
      },
    };
    const { container } = renderOverlay({ block, showChrome: false });

    const guide = container.querySelector<SVGElement>(
      '[data-bubble-layout-guide="manual"]',
    );
    expect(guide).not.toBeNull();
    expect(guide?.querySelectorAll("polygon")).toHaveLength(1);
    expect(guide?.querySelector("polygon")?.getAttribute("points")).toContain(
      "180,0",
    );
    expect(container.querySelector(".overlay-block-chrome")).toBeNull();
  });

  it.each([
    { renderDirection: "vertical" as const, translatedText: "세로" },
    { renderDirection: "horizontal" as const, translatedText: "두\n줄" },
  ])(
    "temporarily falls back to ordinary text for $renderDirection text",
    (patch) => {
      const { container } = renderOverlay({
        block: { ...makeBlock(), ...patch, curveLayout: makeCurveLayout() },
        transformMode: "curve",
      });

      expect(container.querySelector(".overlay-text")).not.toBeNull();
      expect(container.querySelector(".overlay-curve-text")).toBeNull();
      expect(container.querySelector(".curve-controls")).toBeNull();
    },
  );

  it("renders a 3x3-cell warp mesh with 16 accessible point handles", () => {
    const onTransformPointerDown = vi.fn();
    const onWarpTransformCommit = vi.fn();
    const { container } = renderOverlay({
      block: { ...makeBlock(), warpTransform: createIdentityWarpTransform(3) },
      onTransformPointerDown,
      onWarpTransformCommit,
      transformMode: "warp",
    });

    expect(container.querySelectorAll(".warp-point")).toHaveLength(16);
    expect(container.querySelectorAll(".warp-grid-line")).toHaveLength(8);
    const first = container.querySelector<HTMLElement>(
      '[data-transform-handle="warp-point-0"]',
    );
    if (!first) throw new Error("Warp point was not rendered");
    fireEvent.pointerDown(first);
    expect(onTransformPointerDown).toHaveBeenCalledWith(
      expect.anything(),
      "warp-points-0",
    );
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onWarpTransformCommit).toHaveBeenCalledWith(
      expect.objectContaining({ gridSize: 3 }),
    );
    expect(onWarpTransformCommit.mock.calls[0]?.[0].points[0].x).toBeCloseTo(
      1 / 250,
    );
  });

  it("applies an SVG inverse displacement map to rich text before perspective", () => {
    const { container } = renderOverlay({
      block: {
        ...makeBlock(),
        translatedText: "A**굵게**\n둘째 줄",
        perspectiveTransform: {
          version: 1,
          corners: [
            { x: 0.08, y: 0 },
            { x: 0.92, y: 0.04 },
            { x: 1, y: 1 },
            { x: 0, y: 0.94 },
          ],
        },
        warpTransform: createWarpPreset("wave", 3),
      },
      transformMode: "warp",
    });

    expect(
      container.querySelector(".warped-text-content .overlay-text"),
    ).not.toBeNull();
    expect(container.querySelector("feDisplacementMap")).not.toBeNull();
    expect(container.querySelector("filter")?.getAttribute("filterUnits")).toBe(
      "userSpaceOnUse",
    );
    expect(
      container.querySelector("filter")?.getAttribute("primitiveUnits"),
    ).toBe("userSpaceOnUse");
    expect(container.querySelector("img[data-warp-map]")).not.toBeNull();
    expect(
      container.querySelector(
        ".overlay-transform-content > .warped-text-content",
      ),
    ).not.toBeNull();
  });
});

function renderOverlay({
  block = makeBlock(),
  onTransformPointerDown = vi.fn<
    (event: React.PointerEvent, mode: DragMode) => void
  >(),
  onWarpTransformCommit = vi.fn(),
  showChrome = true,
  transformMode = "select",
}: {
  block?: TranslationBlock;
  onTransformPointerDown?: (event: React.PointerEvent, mode: DragMode) => void;
  onWarpTransformCommit?: NonNullable<
    React.ComponentProps<typeof OverlayBlock>["onWarpTransformCommit"]
  >;
  showChrome?: boolean;
  transformMode?: "select" | "perspective" | "curve" | "warp";
} = {}): ReturnType<typeof render> {
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
      <OverlayBlock
        block={block}
        interactionPreviewStore={createWorkspaceInteractionPreviewStore()}
        onPointerDown={vi.fn()}
        onResizePointerDown={vi.fn()}
        onTransformPointerDown={onTransformPointerDown}
        onWarpTransformCommit={onWarpTransformCommit}
        pageSize={{ width: 1000, height: 1000 }}
        selected
        showChrome={showChrome}
        stageSize={{ width: 500, height: 500 }}
        textLayoutStageSize={{ width: 500, height: 500 }}
        transformMode={transformMode}
      />
    </FontsContext.Provider>,
  );
}

function makeCurveLayout(): NonNullable<TranslationBlock["curveLayout"]> {
  return {
    version: 1,
    path: {
      type: "quadratic",
      start: { x: 0.05, y: 0.65 },
      control: { x: 0.5, y: 0.1 },
      end: { x: 0.95, y: 0.65 },
    },
    alignment: "center",
    offsetEm: 0,
    orientation: "tangent",
  };
}

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 500, h: 240 },
    sourceText: "source",
    translatedText: "테스트",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 28,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    outlineColor: "#ffffff",
    backgroundColor: "#ffffff",
    opacity: 1,
    autoFitText: false,
  };
}
