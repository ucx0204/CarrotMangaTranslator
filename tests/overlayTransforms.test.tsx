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
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import type { DragMode } from "../src/renderer/src/lib/workspaceInteractionTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
    }),
  });
});

afterEach(() => cleanup());

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
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
});

function renderOverlay({
  block = makeBlock(),
  onTransformPointerDown = vi.fn<
    (event: React.PointerEvent, mode: DragMode) => void
  >(),
  transformMode = "select",
}: {
  block?: TranslationBlock;
  onTransformPointerDown?: (event: React.PointerEvent, mode: DragMode) => void;
  transformMode?: "select" | "perspective" | "curve";
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
        pageSize={{ width: 1000, height: 1000 }}
        selected
        showChrome
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
