/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceZoomStyle } from "../src/renderer/src/hooks/useWorkspaceZoomStyle";
import type { WorkspaceFitMode } from "../src/renderer/src/lib/workspaceZoom";

beforeEach(() => {
  ResizeObserverStub.reset();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("workspace zoom natural image dimensions", () => {
  it("keeps matching metadata and natural dimensions at actual size", () => {
    const harness = makeHarness({
      metadata: { width: 836, height: 1200 },
      natural: { width: 836, height: 1200 },
    });
    const { result } = renderHook(() =>
      harness.useStyle("actual", harness.source),
    );

    expect(result.current).toEqual({
      className: "is-zoomed",
      effectiveScale: 1,
      imageSize: { height: 1200, width: 836 },
      overscroll: { x: 0, y: 0 },
      pageFits: true,
      scrollOrigin: { x: 0, y: 0 },
      style: {
        "--page-display-h": "1200px",
        "--page-display-w": "836px",
        "--workspace-overscroll-x": "0px",
        "--workspace-overscroll-y": "0px",
      },
    });
  });

  it("uses the natural aspect for fit mode when metadata disagrees", () => {
    const harness = makeHarness({
      container: { width: 1000, height: 1000 },
      metadata: { width: 1000, height: 1400 },
      natural: { width: 836, height: 1200 },
    });
    const { result } = renderHook(() =>
      harness.useStyle("contain", harness.source),
    );

    expect(result.current.style).toEqual({
      "--page-display-h": "1000px",
      "--page-display-w": "696.667px",
      "--workspace-overscroll-x": "0px",
      "--workspace-overscroll-y": "0px",
    });
    expect(result.current.effectiveScale).toBeCloseTo(696.667 / 836);
    expect(result.current.pageFits).toBe(true);
    expect(result.current.scrollOrigin).toEqual({ x: 0, y: 0 });
  });

  it("recomputes screen fit immediately when the workspace is resized", () => {
    const harness = makeHarness({
      container: { width: 800, height: 900 },
      metadata: { width: 800, height: 1200 },
      natural: { width: 800, height: 1200 },
    });
    const { result } = renderHook(() =>
      harness.useStyle("contain", harness.source),
    );

    expect(result.current.style).toMatchObject({
      "--page-display-h": "900px",
      "--page-display-w": "600px",
    });
    harness.resize({ width: 1200, height: 1500 });
    expect(result.current.style).toMatchObject({
      "--page-display-h": "1500px",
      "--page-display-w": "1000px",
    });
    expect(result.current.pageFits).toBe(true);
    expect(result.current.scrollOrigin).toEqual({ x: 0, y: 0 });
  });

  it("adds viewport-relative pasteboard only after page pixels overflow", () => {
    const harness = makeHarness({
      container: { width: 400, height: 500 },
      metadata: { width: 100, height: 1600 },
      natural: { width: 100, height: 1600 },
    });
    const { result } = renderHook(() =>
      harness.useStyle("actual", harness.source),
    );

    expect(result.current.pageFits).toBe(false);
    expect(result.current.overscroll).toEqual({ x: 200, y: 250 });
    expect(result.current.scrollOrigin).toEqual({ x: 50, y: 250 });
    expect(result.current.style).toMatchObject({
      "--workspace-overscroll-x": "200px",
      "--workspace-overscroll-y": "250px",
    });
  });

  it("falls back to metadata until a replacement image finishes loading", () => {
    const harness = makeHarness({
      metadata: { width: 1000, height: 1400 },
      natural: { width: 836, height: 1200 },
    });
    const { result, rerender } = renderHook(
      ({ revision }) => harness.useStyle("actual", revision),
      { initialProps: { revision: harness.source } },
    );
    expect(result.current.style).toMatchObject({
      "--page-display-h": "1200px",
      "--page-display-w": "836px",
    });

    const replacement = "mgt-image://library/replacement";
    harness.replaceImage(replacement, {
      complete: false,
      height: 0,
      width: 0,
    });
    rerender({ revision: replacement });
    expect(result.current.style).toMatchObject({
      "--page-display-h": "1400px",
      "--page-display-w": "1000px",
    });

    harness.replaceImage(replacement, {
      complete: true,
      height: 1280,
      width: 720,
    });
    act(() => {
      harness.image.dispatchEvent(new Event("load"));
    });
    expect(result.current.style).toMatchObject({
      "--page-display-h": "1280px",
      "--page-display-w": "720px",
    });
  });
});

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  static emit(): void {
    for (const instance of ResizeObserverStub.instances) {
      instance.callback([], instance);
    }
  }

  static reset(): void {
    ResizeObserverStub.instances = [];
  }

  observe(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }

  unobserve(): void {
    return undefined;
  }
}

function makeHarness({
  container = { width: 2000, height: 2000 },
  metadata,
  natural,
}: {
  container?: { width: number; height: number };
  metadata: { width: number; height: number };
  natural: { width: number; height: number };
}) {
  const source = "mgt-image://library/current";
  const image = document.createElement("img");
  const imageState = {
    complete: true,
    height: natural.height,
    width: natural.width,
  };
  Object.defineProperties(image, {
    complete: {
      configurable: true,
      get: () => imageState.complete,
    },
    naturalHeight: {
      configurable: true,
      get: () => imageState.height,
    },
    naturalWidth: {
      configurable: true,
      get: () => imageState.width,
    },
  });
  image.setAttribute("src", source);
  const imageRef = React.createRef<HTMLImageElement>();
  imageRef.current = image;
  const containerElement = document.createElement("section");
  const containerSize = { ...container };
  Object.defineProperties(containerElement, {
    clientHeight: { configurable: true, get: () => containerSize.height },
    clientWidth: { configurable: true, get: () => containerSize.width },
  });
  const containerRef = React.createRef<HTMLElement>();
  containerRef.current = containerElement;

  return {
    image,
    resize(next: { height: number; width: number }): void {
      containerSize.height = next.height;
      containerSize.width = next.width;
      act(() => ResizeObserverStub.emit());
    },
    replaceImage(
      revision: string,
      next: { complete: boolean; height: number; width: number },
    ): void {
      imageState.complete = next.complete;
      imageState.height = next.height;
      imageState.width = next.width;
      image.setAttribute("src", revision);
    },
    source,
    useStyle(fitMode: WorkspaceFitMode, imageRevision: string) {
      return useWorkspaceZoomStyle({
        containerRef,
        fitMode,
        imageRef,
        imageRevision,
        page: metadata,
        zoom: 1,
      });
    },
  };
}
