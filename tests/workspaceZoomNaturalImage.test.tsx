/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceZoomStyle } from "../src/renderer/src/hooks/useWorkspaceZoomStyle";
import type { WorkspaceFitMode } from "../src/renderer/src/lib/workspaceZoom";

beforeEach(() => {
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
      style: {
        "--page-display-h": "1200px",
        "--page-display-w": "836px",
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

    expect(result.current).toEqual({
      className: "is-zoomed",
      style: {
        "--page-display-h": "808px",
        "--page-display-w": "563px",
      },
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
  observe(): void {
    return undefined;
  }

  disconnect(): void {
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
  Object.defineProperties(containerElement, {
    clientHeight: { configurable: true, value: container.height },
    clientWidth: { configurable: true, value: container.width },
  });
  const containerRef = React.createRef<HTMLElement>();
  containerRef.current = containerElement;

  return {
    image,
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
