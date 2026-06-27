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

  it("returns null at zoom 1 so default CSS fit is used", () => {
    expect(computeWorkspaceImageSize(1, page, container)).toBeNull();
  });

  it("returns null without measurements", () => {
    expect(computeWorkspaceImageSize(2, page, null)).toBeNull();
    expect(computeWorkspaceImageSize(2, null, container)).toBeNull();
  });

  it("scales the fitted size by the zoom factor", () => {
    const base = computeWorkspaceImageSize(2, page, container);
    expect(base).not.toBeNull();
    // Width-bound fit: min(1000-48, 1040) = 952; height = 952 * 1200/800.
    expect(base?.width).toBe(Math.round(952 * 2));
    expect(base?.height).toBe(Math.round((952 / (800 / 1200)) * 2));
  });

  it("keeps the image within the available height when tall", () => {
    const tallPage = { width: 800, height: 4000 };
    const result = computeWorkspaceImageSize(1.5, tallPage, {
      width: 1000,
      height: 600,
    });
    // Height-bound: availHeight 600-48 = 552, then * zoom.
    expect(result?.height).toBe(Math.round(552 * 1.5));
  });
});
