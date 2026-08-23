/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import {
  resolveWheelZoomRatio,
  useWorkspaceZoomController,
} from "../src/renderer/src/hooks/useWorkspaceZoomController";
import {
  captureWorkspaceZoomAnchor,
  resolveSelectedBlockCenter,
  restoreWorkspaceZoomAnchor,
} from "../src/renderer/src/lib/workspaceZoomAnchors";
import type { WorkspaceZoomController } from "../src/renderer/src/lib/workspaceZoom";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workspace zoom controller", () => {
  it("maps one physical wheel notch to one real 1% zoom change", () => {
    expect(resolveWheelZoomRatio(1)).toBeGreaterThan(1);
    expect(resolveWheelZoomRatio(1)).toBeLessThan(1.001);
    expect(resolveWheelZoomRatio(100)).toBeCloseTo(1.01, 6);
    expect(resolveWheelZoomRatio(200)).toBeCloseTo(1.01 ** 2, 6);
    expect(resolveWheelZoomRatio(Number.NaN)).toBe(1);
  });

  it("centres the transformed union for a group selection", () => {
    const page = makePage();
    expect(resolveSelectedBlockCenter(page, "a", ["a"])).toEqual({
      x: 150,
      y: 150,
    });
    expect(resolveSelectedBlockCenter(page, "a", ["a", "b"])).toEqual({
      x: 500,
      y: 350,
    });
    expect(resolveSelectedBlockCenter(page, "b", ["a"])).toEqual({
      x: 150,
      y: 150,
    });
    expect(resolveSelectedBlockCenter(page, "b", ["missing"])).toEqual({
      x: 800,
      y: 550,
    });

    const rotatedPage = makePage();
    rotatedPage.blocks[0] = {
      ...rotatedPage.blocks[0],
      renderBbox: { x: 100, y: 100, w: 100, h: 300 },
      rotationDeg: 90,
    };
    expect(resolveSelectedBlockCenter(rotatedPage, "a", ["a", "b"])).toEqual({
      x: 450,
      y: 400,
    });
  });

  it("keeps the selected block centre at its current screen position", () => {
    const panel = document.createElement("section");
    const image = document.createElement("img");
    let layoutZoom = 1;
    panel.getBoundingClientRect = () => rect(0, 0, 1000, 800);
    image.getBoundingClientRect = () =>
      rect(0, 0, 1000 * layoutZoom, 1000 * layoutZoom);
    const panelRef = React.createRef<HTMLElement>();
    const imageRef = React.createRef<HTMLImageElement>();
    const controllerRef = React.createRef<WorkspaceZoomController | null>();
    panelRef.current = panel;
    imageRef.current = image;
    const page = makePage();
    const { result } = renderHook(() => {
      const [zoom, setZoom] = React.useState(1);
      useWorkspaceZoomController({
        controllerRef,
        fitMode: "contain",
        imageRef,
        layoutHeight: 1000 * zoom,
        layoutWidth: 1000 * zoom,
        onChangeZoom: (nextZoom) => {
          layoutZoom = nextZoom;
          setZoom(nextZoom);
        },
        page,
        pageFits: false,
        panelRef,
        selectedBlockId: "b",
        selectedBlockIds: ["b"],
        zoom,
      });
      return zoom;
    });

    act(() => controllerRef.current?.zoomInAtSelection());

    expect(result.current).toBe(1.12);
    expect(panel.scrollLeft).toBe(96);
    expect(panel.scrollTop).toBe(66);
  });

  it("keeps the selected centre anchored through the immediate scrollbar layout pass only", () => {
    vi.useFakeTimers();
    const panel = document.createElement("section");
    const image = document.createElement("img");
    let renderedWidth = 1000;
    let renderedHeight = 1000;
    panel.getBoundingClientRect = () => rect(0, 0, 1000, 800);
    image.getBoundingClientRect = () =>
      rect(-panel.scrollLeft, -panel.scrollTop, renderedWidth, renderedHeight);
    const panelRef = React.createRef<HTMLElement>();
    const imageRef = React.createRef<HTMLImageElement>();
    const controllerRef = React.createRef<WorkspaceZoomController | null>();
    panelRef.current = panel;
    imageRef.current = image;
    const page = makePage();
    const { result } = renderHook(() => {
      const [zoom, setZoom] = React.useState(1);
      const [layoutFactor, setLayoutFactor] = React.useState(1);
      renderedWidth = 1000 * zoom * layoutFactor;
      renderedHeight = 1000 * zoom * layoutFactor;
      useWorkspaceZoomController({
        controllerRef,
        fitMode: "contain",
        imageRef,
        layoutHeight: renderedHeight,
        layoutWidth: renderedWidth,
        onChangeZoom: setZoom,
        page,
        pageFits: false,
        panelRef,
        selectedBlockId: "b",
        selectedBlockIds: ["b"],
        zoom,
      });
      return { setLayoutFactor, zoom };
    });

    act(() => controllerRef.current?.zoomInAtSelection());
    expect(panel.scrollLeft).toBe(96);
    expect(panel.scrollTop).toBe(66);

    act(() => result.current.setLayoutFactor(1100 / 1120));
    expect(panel.scrollLeft).toBe(80);
    expect(panel.scrollTop).toBe(55);

    act(() => vi.advanceTimersByTime(65));
    act(() => result.current.setLayoutFactor(1));
    expect(panel.scrollLeft).toBe(80);
    expect(panel.scrollTop).toBe(55);
  });

  it("restores the same image coordinate to the same viewport pixel", () => {
    const panel = document.createElement("section");
    const image = document.createElement("div");
    panel.scrollLeft = 500;
    panel.scrollTop = 400;
    panel.getBoundingClientRect = () => rect(100, 50, 800, 600);
    image.getBoundingClientRect = () => rect(200, 100, 400, 800);
    const anchor = captureWorkspaceZoomAnchor({
      image,
      pageId: "page-1",
      panel,
      spec: { kind: "client", point: { x: 300, y: 250 } },
    });
    expect(anchor).toMatchObject({
      imageXRatio: 0.25,
      imageYRatio: 0.1875,
      target: "fixed",
      viewportX: 200,
      viewportY: 200,
    });
    if (!anchor) throw new Error("zoom anchor was not captured");

    image.getBoundingClientRect = () => rect(150, 20, 800, 1600);
    restoreWorkspaceZoomAnchor({ anchor, image, panel });
    expect(panel.scrollLeft).toBe(550);
    expect(panel.scrollTop).toBe(470);
  });

  it("commits toolbar and wheel input immediately without trailing animation", () => {
    const panel = document.createElement("section");
    const image = document.createElement("img");
    panel.getBoundingClientRect = () => rect(0, 0, 1000, 800);
    image.getBoundingClientRect = () => rect(250, 0, 500, 800);
    const panelRef = React.createRef<HTMLElement>();
    const imageRef = React.createRef<HTMLImageElement>();
    const controllerRef = React.createRef<WorkspaceZoomController | null>();
    panelRef.current = panel;
    imageRef.current = image;
    const page = makePage();
    const { result } = renderHook(() => {
      const [zoom, setZoom] = React.useState(1);
      useWorkspaceZoomController({
        controllerRef,
        fitMode: "contain",
        imageRef,
        layoutHeight: 800 * zoom,
        layoutWidth: 500 * zoom,
        onChangeZoom: setZoom,
        page,
        pageFits: true,
        panelRef,
        selectedBlockId: "a",
        selectedBlockIds: ["a"],
        zoom,
      });
      return zoom;
    });

    act(() => controllerRef.current?.zoomInAtSelection());
    expect(result.current).toBe(1.12);

    act(() =>
      controllerRef.current?.zoomAtPointer({
        clientX: 400,
        clientY: 300,
        deltaPixels: 100,
        direction: "out",
      }),
    );
    expect(result.current).toBeCloseTo(1.12 / 1.01, 4);

    act(() => controllerRef.current?.zoomOutAtViewport());
    expect(result.current).toBeCloseTo(1 / 1.01, 4);

    act(() => controllerRef.current?.resetAtViewport());
    expect(result.current).toBe(1);
    act(() => controllerRef.current?.resetAtViewport());
    expect(result.current).toBe(1);
  });
});

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "page.png",
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [
      makeBlock("a", { x: 100, y: 100, w: 100, h: 100 }),
      makeBlock("b", { x: 700, y: 500, w: 200, h: 100 }),
    ],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(
  id: string,
  renderBbox: MangaPage["blocks"][number]["bbox"],
): MangaPage["blocks"][number] {
  return {
    id,
    type: "nonsolid",
    bbox: renderBbox,
    renderBbox,
    renderBboxSpace: "normalized_1000",
    sourceText: id,
    translatedText: id,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}
