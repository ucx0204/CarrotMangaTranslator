import { describe, expect, it } from "vitest";
import {
  describeDragBbox,
  resolveDraggedBbox,
  resolveDraggedPerspective,
  resolveDraggedRotationWithSnap,
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
      startBlock: { rotationDeg: 0 } as DragState["startBlock"],
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

  it("resizes on rotated local axes and keeps the opposite side anchored", () => {
    const drag: DragState = {
      blockId: "block-1",
      mode: "resize-e",
      startX: 100,
      startY: 50,
      startBbox: { x: 250, y: 250, w: 500, h: 500 },
      startBlock: { rotationDeg: 90 } as DragState["startBlock"],
    };
    const result = resolveDraggedBbox(
      drag,
      { clientX: 100, clientY: 70 },
      { left: 0, top: 0, width: 200, height: 100 },
      { width: 200, height: 100 },
    );

    expect(result.w).toBeCloseTo(600);
    expect(result.h).toBeCloseTo(500);
    expect(result.x).toBeCloseTo(200);
    expect(result.y).toBeCloseTo(350);
  });

  it("keeps the starting ratio for Shift corner resize", () => {
    const drag: DragState = {
      blockId: "block-1",
      mode: "resize-se",
      startX: 0,
      startY: 0,
      startBbox: { x: 100, y: 100, w: 400, h: 200 },
      startBlock: { rotationDeg: 0 } as DragState["startBlock"],
    };
    const result = resolveDraggedBbox(
      drag,
      { clientX: 20, clientY: 2, shiftKey: true },
      { left: 0, top: 0, width: 200, height: 100 },
      { width: 200, height: 100 },
    );

    expect(result.w / result.h).toBeCloseTo(2);
    expect(result.x).toBe(100);
    expect(result.y).toBe(100);
  });

  it("reports Shift and weak 45 degree rotation snaps", () => {
    const drag: DragState = {
      blockId: "block-1",
      mode: "rotate",
      startX: 100,
      startY: 0,
      startBbox: { x: 0, y: 0, w: 1000, h: 1000 },
      startBlock: { rotationDeg: 0 } as DragState["startBlock"],
    };
    const rect = { left: 0, top: 0, width: 100, height: 100 };

    expect(
      resolveDraggedRotationWithSnap(
        drag,
        { clientX: 100, clientY: 45, shiftKey: true },
        rect,
      ),
    ).toMatchObject({ snapped: true, rotationDeg: 45 });
    expect(
      resolveDraggedRotationWithSnap(drag, { clientX: 100, clientY: 48 }, rect),
    ).toMatchObject({ snapped: true, rotationDeg: 45 });
  });

  it("moves both corners for a perspective edge handle", () => {
    const drag: DragState = {
      blockId: "block-1",
      mode: "perspective-top",
      startX: 50,
      startY: 20,
      startBbox: { x: 100, y: 100, w: 500, h: 400 },
      startBlock: { rotationDeg: 0 } as DragState["startBlock"],
    };
    const result = resolveDraggedPerspective(
      drag,
      { clientX: 50, clientY: 30 },
      {
        version: 1,
        corners: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      },
      { left: 0, top: 0, width: 100, height: 100 },
    );

    expect(result.corners[0].y).toBeCloseTo(0.25);
    expect(result.corners[1].y).toBeCloseTo(0.25);
    expect(result.corners[2]).toEqual({ x: 1, y: 1 });
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
