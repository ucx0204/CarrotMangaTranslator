import { describe, expect, it } from "vitest";
import {
  clampWorkspaceZoom,
  computeWorkspaceOverscroll,
  computeWorkspaceImageSize,
  computeWorkspaceScrollOrigin,
  doesWorkspacePageFit,
  MAX_WORKSPACE_ZOOM,
  MIN_WORKSPACE_ZOOM,
  stepWorkspaceZoom,
} from "../src/renderer/src/lib/workspaceZoom";

describe("clampWorkspaceZoom", () => {
  it("retains continuous precision and clamps to bounds", () => {
    expect(clampWorkspaceZoom(1.25)).toBe(1.25);
    expect(clampWorkspaceZoom(1.01337)).toBe(1.0134);
    expect(clampWorkspaceZoom(10)).toBe(MAX_WORKSPACE_ZOOM);
    expect(clampWorkspaceZoom(0.1)).toBe(MIN_WORKSPACE_ZOOM);
    expect(clampWorkspaceZoom(Number.NaN)).toBe(1);
  });

  it("steps both toolbar zoom directions continuously", () => {
    expect(stepWorkspaceZoom(1, "in")).toBe(1.12);
    expect(stepWorkspaceZoom(1.12, "out")).toBe(1);
  });
});

describe("workspace overscroll", () => {
  it("follows half the current viewport instead of a fixed pixel gutter", () => {
    expect(computeWorkspaceOverscroll({ width: 1000, height: 760 })).toEqual({
      x: 500,
      y: 380,
    });
  });

  it("centres fitted page pixels instead of pinning them to the left edge", () => {
    const container = { width: 1000, height: 760 };
    const overscroll = computeWorkspaceOverscroll(container);
    expect(
      computeWorkspaceScrollOrigin(
        container,
        { width: 500, height: 760 },
        overscroll,
      ),
    ).toEqual({ x: 250, y: 380 });
    expect(
      computeWorkspaceScrollOrigin(
        container,
        { width: 1200, height: 900 },
        overscroll,
      ),
    ).toEqual(overscroll);
  });

  it("shows native bars only when page pixels are clipped", () => {
    const viewport = { width: 1000, height: 760 };
    expect(doesWorkspacePageFit({ width: 500, height: 760 }, viewport)).toBe(
      true,
    );
    expect(doesWorkspacePageFit({ width: 1001, height: 760 }, viewport)).toBe(
      false,
    );
  });
});

describe("computeWorkspaceImageSize", () => {
  const page = { width: 800, height: 1200 };
  const container = { width: 1000, height: 2000 };

  it("fits the whole image to the workspace and upscales small pages", () => {
    expect(computeWorkspaceImageSize(1, "contain", page, container)).toEqual({
      width: 1000,
      height: 1500,
    });
  });

  it("returns null without measurements", () => {
    expect(computeWorkspaceImageSize(2, "contain", page, null)).toBeNull();
    expect(computeWorkspaceImageSize(2, "contain", null, container)).toBeNull();
  });

  it("scales the fitted size by the zoom factor", () => {
    const base = computeWorkspaceImageSize(2, "contain", page, container);
    expect(base).not.toBeNull();
    // The editing pasteboard remains scrollable outside the fitted page.
    expect(base?.width).toBe(2000);
    expect(base?.height).toBe(3000);
  });

  it("keeps the whole image within the available height when tall", () => {
    const tallPage = { width: 800, height: 4000 };
    const result = computeWorkspaceImageSize(1.5, "contain", tallPage, {
      width: 1000,
      height: 600,
    });
    // Height-bound against the viewport itself, then scaled by zoom.
    expect(result?.height).toBe(900);
  });

  it("supports width, height, and actual-pixel bases", () => {
    const compactContainer = { width: 1000, height: 800 };
    expect(
      computeWorkspaceImageSize(1, "width", page, compactContainer),
    ).toEqual({
      width: 1000,
      height: 1500,
    });
    expect(
      computeWorkspaceImageSize(1, "height", page, compactContainer),
    ).toEqual({
      width: 533.333,
      height: 800,
    });
    expect(
      computeWorkspaceImageSize(1, "actual", page, compactContainer),
    ).toEqual(page);
  });
});
