import { describe, expect, it } from "vitest";
import { resolvePatternInpaintWindows } from "../src/main/inpainting/patternWindowPolicy";

describe("pattern inpainting window policy", () => {
  const touchingWindows = [
    { x: 10, y: 10, w: 40, h: 40 },
    { x: 50, y: 10, w: 40, h: 40 },
  ];

  it("keeps every selected-model window separate on every backend", () => {
    const resolved = resolvePatternInpaintWindows(touchingWindows);

    expect(resolved).toEqual(touchingWindows);
    expect(resolved[0]).not.toBe(touchingWindows[0]);
  });
});
