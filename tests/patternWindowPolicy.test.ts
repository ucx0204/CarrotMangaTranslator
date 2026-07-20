import { describe, expect, it } from "vitest";
import type { InpaintingEngine } from "../src/main/inpainting/inpaintingEngine";
import {
  resolveInpaintingBackendPolicy,
  resolvePatternInpaintWindows,
} from "../src/main/inpainting/patternWindowPolicy";

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

  it("keeps Flux CUDA windows separate for owned-mask processing", () => {
    expect(
      resolvePatternInpaintWindows(
        touchingWindows,
        createEngine("flux-klein", "cuda-native"),
      ),
    ).toEqual(touchingWindows);
  });

  it("merges transitive overlap for the Koharu whole-page path", () => {
    expect(
      resolvePatternInpaintWindows(
        [
          { x: 0, y: 0, w: 10, h: 10 },
          { x: 20, y: 0, w: 10, h: 10 },
          { x: 9, y: 0, w: 12, h: 10 },
        ],
        createEngine("lama-manga", "cuda"),
      ),
    ).toEqual([{ x: 0, y: 0, w: 30, h: 10 }]);
  });

  it("snapshots backend policies independently", () => {
    expect({
      cuda: resolveInpaintingBackendPolicy(
        createEngine("flux-klein", "cuda-native"),
      ),
      koharu: resolveInpaintingBackendPolicy(
        createEngine("lama-manga", "cuda"),
      ),
      metal: resolveInpaintingBackendPolicy(
        createEngine("flux-klein", "metal-native"),
      ),
    }).toMatchInlineSnapshot(`
      {
        "cuda": {
          "bubbleMaskStrategy": "omit",
          "contextPx": 160,
          "cropStrategy": "scaled-to-budget",
          "enginePath": "flux",
          "featherPx": 8,
          "maskPaddingPx": 16,
          "maskStrategy": "owned",
          "maxContextPx": null,
          "maxCropSizePx": null,
          "maxPixels": 1048576,
          "windowStrategy": "preserve",
        },
        "koharu": {
          "bubbleMaskStrategy": "forward",
          "contextPx": 160,
          "cropStrategy": "whole-page",
          "enginePath": "koharu",
          "featherPx": 8,
          "maskPaddingPx": 16,
          "maskStrategy": "owned",
          "maxContextPx": null,
          "maxCropSizePx": null,
          "maxPixels": 1048576,
          "windowStrategy": "merge",
        },
        "metal": {
          "bubbleMaskStrategy": "omit",
          "contextPx": 96,
          "cropStrategy": "tiled-native",
          "enginePath": "flux",
          "featherPx": 8,
          "maskPaddingPx": 16,
          "maskStrategy": "owned",
          "maxContextPx": 96,
          "maxCropSizePx": 512,
          "maxPixels": 1048576,
          "windowStrategy": "preserve",
        },
      }
    `);
  });
});
