import { describe, expect, it } from "vitest";
import {
  describeDragBbox,
  resolveDraggedBbox,
  resolveNormalizedImagePoint,
  type DragState,
} from "../src/renderer/src/hooks/workspacePointerGeometry";

describe("workspace pointer geometry", () => {
  it("formats move and resize drag HUD labels in page pixels", () => {
    const page = { width: 2000, height: 1000 };

    expect(
      describeDragBbox("move", { x: 250, y: 500, w: 100, h: 200 }, page),
    ).toBe("500, 500");
    expect(
      describeDragBbox("resize", { x: 250, y: 500, w: 100, h: 200 }, page),
    ).toBe("200 × 200px");
  });

  it("moves or resizes a normalized bbox from pointer delta", () => {
    const drag: DragState = {
      blockId: "block-1",
      mode: "move",
      startX: 10,
      startY: 20,
      startBbox: { x: 100, y: 200, w: 300, h: 400 },
    };
    const rect = { left: 0, top: 0, width: 200, height: 100 };

    expect(
      resolveDraggedBbox(drag, { clientX: 30, clientY: 30 }, rect),
    ).toEqual({ x: 200, y: 300, w: 300, h: 400 });
    expect(
      resolveDraggedBbox(
        { ...drag, mode: "resize" },
        { clientX: 30, clientY: 30 },
        rect,
      ),
    ).toEqual({ x: 100, y: 200, w: 400, h: 500 });
  });

  it("normalizes client points and clamps outside the image rect", () => {
    const rect = { left: 10, top: 20, width: 200, height: 100 };

    expect(
      resolveNormalizedImagePoint({ clientX: 110, clientY: 70 }, rect),
    ).toEqual({ x: 500, y: 500 });
    expect(
      resolveNormalizedImagePoint({ clientX: -10, clientY: 200 }, rect),
    ).toEqual({ x: 0, y: 1000 });
  });

  it("returns null for an unusable image rect", () => {
    expect(
      resolveNormalizedImagePoint(
        { clientX: 110, clientY: 70 },
        { left: 0, top: 0, width: 0, height: 100 },
      ),
    ).toBeNull();
  });
});
