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
    const resolved = resolvePatternInpaintWindows(
      touchingWindows,
      createEngine("flux-klein", "metal-native"),
    );

    expect(resolved).toEqual(touchingWindows);
    expect(resolved[0]).not.toBe(touchingWindows[0]);
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

  it("merges transitive overlap into a single window", () => {
    expect(
      resolvePatternInpaintWindows(
        [
          { x: 0, y: 0, w: 10, h: 10 },
          { x: 20, y: 0, w: 10, h: 10 },
          { x: 9, y: 0, w: 12, h: 10 },
        ],
        createEngine("flux-klein", "cuda-native"),
      ),
    ).toEqual([{ x: 0, y: 0, w: 30, h: 10 }]);
  });
});
