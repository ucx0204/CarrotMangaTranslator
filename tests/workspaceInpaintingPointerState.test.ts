import { describe, expect, it } from "vitest";
import {
  appendMaskStroke,
  isRetouchDrawTool,
  resolveImagePixelPoint,
} from "../src/renderer/src/hooks/workspaceInpaintingPointerState";

describe("workspace inpainting pointer state", () => {
  it("recognizes retouch drawing tools", () => {
    expect(isRetouchDrawTool("brush")).toBe(true);
    expect(isRetouchDrawTool("eraser")).toBe(true);
    expect(isRetouchDrawTool("mask")).toBe(true);
    expect(isRetouchDrawTool("picker")).toBe(false);
    expect(isRetouchDrawTool("none")).toBe(false);
  });

  it("resolves image pixel points and clamps outside the rendered image", () => {
    const rect = { left: 10, top: 20, width: 200, height: 100 };
    const page = { width: 1000, height: 500 };

    expect(
      resolveImagePixelPoint({ clientX: 110, clientY: 70 }, rect, page),
    ).toEqual({ x: 500, y: 250 });
    expect(
      resolveImagePixelPoint({ clientX: -10, clientY: 200 }, rect, page),
    ).toEqual({ x: 0, y: 499 });
  });

  it("returns null for unusable rendered image bounds", () => {
    expect(
      resolveImagePixelPoint(
        { clientX: 110, clientY: 70 },
        { left: 0, top: 0, width: 0, height: 100 },
        { width: 1000, height: 500 },
      ),
    ).toBeNull();
  });

  it("appends mask strokes and caps retained strokes per page", () => {
    const current = {
      page: Array.from({ length: 200 }, (_, index) => ({
        points: [{ x: index, y: index }],
        radiusPx: 4,
      })),
    };
    const next = appendMaskStroke(current, "page", [{ x: 300, y: 400 }], 12);

    expect(next.page).toHaveLength(200);
    expect(next.page[0]?.points[0]).toEqual({ x: 1, y: 1 });
    expect(next.page[199]).toEqual({
      points: [{ x: 300, y: 400 }],
      radiusPx: 12,
    });
  });
});
