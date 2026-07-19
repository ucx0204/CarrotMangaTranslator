import { describe, expect, it } from "vitest";
import type { InpaintingEngine } from "../src/main/inpainting/inpaintingEngine";
import { resolvePatternInpaintWindows } from "../src/main/inpainting/patternWindowPolicy";

function createEngine(
  model: InpaintingEngine["model"],
  backend: string,
): InpaintingEngine {
  return {
    model,
    backend,
    runtimePath: "/tmp/runtime",
    runRootDir: "/tmp/run",
    async inpaint() {},
    async dispose() {},
  };
}

describe("resolvePatternInpaintWindows", () => {
  const touchingWindows = [
    { x: 0, y: 0, w: 20, h: 20 },
    { x: 20, y: 0, w: 20, h: 20 },
  ];

  it("keeps Flux Metal windows separate for block-by-block processing", () => {
    const windows = resolvePatternInpaintWindows(
      touchingWindows,
      createEngine("flux-klein", "metal-native"),
    );

    expect(windows).toEqual(touchingWindows);
    expect(windows[0]).not.toBe(touchingWindows[0]);
  });

  it.each([
    ["flux-klein", "cuda-native"],
    ["lama-manga", "metal-native"],
  ] as const)("merges windows for %s on %s", (model, backend) => {
    expect(
      resolvePatternInpaintWindows(
        touchingWindows,
        createEngine(model, backend),
      ),
    ).toEqual([{ x: 0, y: 0, w: 40, h: 20 }]);
  });
});
