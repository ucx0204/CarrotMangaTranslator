import { describe, expect, it } from "vitest";
import {
  clampWorkspaceZoom,
  computeWorkspaceImageSize,
  MAX_WORKSPACE_ZOOM,
  MIN_WORKSPACE_ZOOM,
} from "../src/renderer/src/lib/workspaceZoom";

describe("clampWorkspaceZoom", () => {
  it("snaps to the configured step and clamps to bounds", () => {
    expect(clampWorkspaceZoom(1.25)).toBe(1.25);
    expect(clampWorkspaceZoom(10)).toBe(MAX_WORKSPACE_ZOOM);
    expect(clampWorkspaceZoom(0.1)).toBe(MIN_WORKSPACE_ZOOM);
    expect(clampWorkspaceZoom(Number.NaN)).toBe(1);
  });
});

describe("computeWorkspaceImageSize", () => {
  const page = { width: 800, height: 1200 };
  const container = { width: 1000, height: 2000 };

  it("fits the whole image to the workspace and upscales small pages", () => {
    expect(computeWorkspaceImageSize(1, "contain", page, container)).toEqual({
      width: 952,
      height: 1428,
    });
  });

  it("returns null without measurements", () => {
    expect(computeWorkspaceImageSize(2, "contain", page, null)).toBeNull();
    expect(computeWorkspaceImageSize(2, "contain", null, container)).toBeNull();
  });

  it("scales the fitted size by the zoom factor", () => {
    const base = computeWorkspaceImageSize(2, "contain", page, container);
    expect(base).not.toBeNull();
    // Width-bound fit: 1000-48 = 952; height = 952 * 1200/800.
    expect(base?.width).toBe(Math.round(952 * 2));
    expect(base?.height).toBe(Math.round((952 / (800 / 1200)) * 2));
  });

  it("keeps the whole image within the available height when tall", () => {
    const tallPage = { width: 800, height: 4000 };
    const result = computeWorkspaceImageSize(1.5, "contain", tallPage, {
      width: 1000,
      height: 600,
    });
    // Height-bound: availHeight 600-48 = 552, then * zoom.
    expect(result?.height).toBe(Math.round(552 * 1.5));
  });

  it("supports width, height, and actual-pixel bases", () => {
    const compactContainer = { width: 1000, height: 800 };
    expect(
      computeWorkspaceImageSize(1, "width", page, compactContainer),
    ).toEqual({
      width: 952,
      height: 1428,
    });
    expect(
      computeWorkspaceImageSize(1, "height", page, compactContainer),
    ).toEqual({
      width: 501,
      height: 752,
    });
    expect(
      computeWorkspaceImageSize(1, "actual", page, compactContainer),
    ).toEqual(page);
  });
});
